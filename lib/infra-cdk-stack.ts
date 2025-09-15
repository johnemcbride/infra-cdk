import * as cdk from 'aws-cdk-lib';
import { Stack, Duration, RemovalPolicy, aws_ec2 as ec2, aws_iam as iam,
				 aws_autoscaling as asg, aws_ssm as ssm, aws_s3 as s3,
				 aws_s3_deployment as s3deploy } from 'aws-cdk-lib';

import { Construct } from 'constructs';

export class InfraCdkStack extends Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		// 1) Network (simple: public only; Cloudflare Tunnel means no inbound ports)
		const vpc = new ec2.Vpc(this, 'Vpc', {
			natGateways: 0,
			maxAzs: 2,
			subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }]
		});

		// 2) Bucket for versioned compose bundles
		const bundleBucket = new s3.Bucket(this, 'ComposeBucket', {
			versioned: true,
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			encryption: s3.BucketEncryption.S3_MANAGED,
			removalPolicy: RemovalPolicy.RETAIN,
			enforceSSL: true
		});

		// (Optional) Seed a default empty bundle so first boot doesn't fail
		new s3deploy.BucketDeployment(this, 'SeedBundle', {
			destinationBucket: bundleBucket,
			destinationKeyPrefix: 'bundles/',
			sources: [s3deploy.Source.asset('user-data/seed-bundle')], // place a minimal zip here
			retainOnDelete: true
		});

		// 3) Parameter the app CI will bump (e.g., "bundles/platform-2025-09-15.zip")
		const composeKeyParam = new ssm.StringParameter(this, 'ComposeKeyParam', {
			parameterName: '/platform/compose_key',
			stringValue: 'bundles/seed.zip'
		});


		// 4) Instance Role
		const role = new iam.Role(this, 'InstanceRole', {
			assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com')
		});
		role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
		role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'));
		// Read bundle + read SSM param
		role.addToPolicy(new iam.PolicyStatement({
			actions: ['s3:GetObject'],
			resources: [bundleBucket.arnForObjects('*')]
		}));
		role.addToPolicy(new iam.PolicyStatement({
			actions: ['ssm:GetParameter', 'ssm:GetParameters'],
			resources: [composeKeyParam.parameterArn]
		}));

		// 4b) Instance Profile for EC2
		const instanceProfile = new iam.CfnInstanceProfile(this, 'InstanceProfile', {
			roles: [role.roleName]
		});

		// 5) Security Group (egress only)
		const sg = new ec2.SecurityGroup(this, 'Sg', { vpc, allowAllOutbound: true });

		// 6) Launch Template + User Data
		const userData = ec2.UserData.forLinux();
		userData.addCommands(
			// Harden IMDSv2 is default on LT; we’ll still be explicit
			'set -euxo pipefail',
			// Install docker + compose plugin (Amazon Linux 2023)
			'dnf update -y',
			'dnf install -y docker git unzip',
			'systemctl enable --now docker',
			// Fetch compose bundle key from SSM
			`COMPOSE_KEY=$(aws ssm get-parameter --name ${composeKeyParam.parameterName} --query 'Parameter.Value' --output text --region ${this.region})`,
			`aws s3 cp s3://${bundleBucket.bucketName}/$COMPOSE_KEY /opt/bundle.zip`,
			'mkdir -p /opt/platform && unzip -o /opt/bundle.zip -d /opt/platform',
			// Bring up core stack (Traefik/Portainer/cloudflared) from the bundle
			'cd /opt/platform && docker compose pull && docker compose up -d',
			// Spot interruption handler: drain gracefully
			'cat >/usr/local/bin/spot-drain.sh <<EOF\n' +
			'#!/usr/bin/env bash\n' +
			'set -euo pipefail\n' +
			'URL=http://169.254.169.254/latest/meta-data/spot/instance-action\n' +
			'while sleep 5; do\n' +
			'  if curl -sf $URL >/dev/null; then\n' +
			'    echo "[spot] interruption notice received; stopping containers..." | systemd-cat -t spot\n' +
			'    docker compose -f /opt/platform/compose.yml down\n' +
			'    sleep 100\n' +
			'  fi\n' +
			'done\nEOF\n' +
			'chmod +x /usr/local/bin/spot-drain.sh',
			'cat >/etc/systemd/system/spot-drain.service <<EOF\n' +
			'[Unit]\nDescription=Spot Interruption Drainer\nAfter=docker.service\n' +
			'[Service]\nExecStart=/usr/local/bin/spot-drain.sh\nRestart=always\n' +
			'[Install]\nWantedBy=multi-user.target\nEOF\n',
			'systemctl enable --now spot-drain.service'
		);

		       const lt = new ec2.CfnLaunchTemplate(this, 'Lt', {
			       launchTemplateName: 'PlatformLaunchTemplate',
		       launchTemplateData: {
			       imageId: ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 }).getImage(this).imageId,
			       instanceType: 'c7g.medium',
			       iamInstanceProfile: {
				       arn: instanceProfile.attrArn
			       },
			       securityGroupIds: [sg.securityGroupId],
			       userData: cdk.Fn.base64(userData.render()),
			       metadataOptions: {
				       httpTokens: 'required'
			       }
		       }
		       });

			const asgGroup = new asg.CfnAutoScalingGroup(this, 'Asg', {
				vpcZoneIdentifier: vpc.selectSubnets({ subnetType: ec2.SubnetType.PUBLIC }).subnetIds,
				minSize: '1',
				maxSize: '1',
				mixedInstancesPolicy: {
					launchTemplate: {
						launchTemplateSpecification: {
							launchTemplateId: lt.ref,
							version: lt.attrLatestVersionNumber
						},
			       overrides: [
				       { instanceType: 'c7g.medium' },
				       { instanceType: 'm7g.medium' },
				       { instanceType: 'r7g.medium' }
			       ]
					},
					instancesDistribution: {
						onDemandPercentageAboveBaseCapacity: 0,
						spotAllocationStrategy: 'capacity-optimized'
					}
				}
			});

			new cdk.CfnOutput(this, 'BucketName', { value: bundleBucket.bucketName });
			new cdk.CfnOutput(this, 'ComposeParam', { value: composeKeyParam.parameterName });
	}
}
