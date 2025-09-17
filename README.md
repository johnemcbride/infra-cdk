# Connect to EC2 via SSM Session Manager

To get the instance ID of your running EC2 and connect via Session Manager:

1. **Get the instance ID:**
	```sh
	aws autoscaling describe-auto-scaling-groups \
	  --auto-scaling-group-names InfraCdkStack-Asg-1RjTUHO1jt7o \
	  --query "AutoScalingGroups[0].Instances[?LifecycleState=='InService'].InstanceId" \
	  --output text --region us-east-1
	```

2. **Connect via SSM Session Manager:**
	```sh
	aws ssm start-session --target <instance-id> --region us-east-1
	```

Or combine into a one-liner:
	```sh
	aws ssm start-session --target $(
	  aws autoscaling describe-auto-scaling-groups \
		 --auto-scaling-group-names InfraCdkStack-Asg-1RjTUHO1jt7o \
		 --query "AutoScalingGroups[0].Instances[?LifecycleState=='InService'].InstanceId" \
		 --output text --region us-east-1
	) --region us-east-1
	```
# Manual Reset & Deployment Commands

To manually reset and deploy the platform, use the following commands:

1. **Build and zip your Docker Compose bundle:**
	```sh
	cd apps-platform/compose/production
	zip -r ../../bundle.zip .
	cd ../..
	```

2. **Upload the bundle to S3:**
	```sh
	aws s3 cp bundle.zip s3://<your-bucket>/bundles/platform-YYYY-MM-DD.zip --profile default --region <your-region>
	```

3. **Update the SSM parameter to point to the new bundle:**
	```sh
	aws ssm put-parameter --name /platform/compose_key --type String --value "bundles/platform-YYYY-MM-DD.zip" --overwrite --profile default --region <your-region>
	```

4. **Trigger an instance refresh in the Auto Scaling Group:**
	```sh
	aws autoscaling start-instance-refresh --auto-scaling-group-name <your-asg-name> --profile default --region <your-region>
	```

5. **(Optional) Set AWS SSO credentials for the default profile:**
	```sh
	aws sso login --profile default
	eval $(aws configure export-credentials --profile default --format env)
	```

Replace `<your-bucket>`, `<your-region>`, and `<your-asg-name>` with your actual values.
# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   compile typescript to js
* `npm run watch`   watch for changes and compile
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template
