// Core CDK classes
import {Stack, StackProps, Duration, RemovalPolicy} from 'aws-cdk-lib';
// Base construct class
import {Construct} from 'constructs';
// VPC and networking
import * as ec2 from 'aws-cdk-lib/aws-ec2';
// ECS (Elastic Container Service)
import * as ecs from 'aws-cdk-lib/aws-ecs';
// RDS (Relational Database Service)
import * as rds from 'aws-cdk-lib/aws-rds';
// ECS Patterns for Load Balanced services
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
// Secrets Manager for storing DB credentials
import * as secretsManager from 'aws-cdk-lib/aws-secretsmanager';
// IAM (Identity and Access Management) for assigning permissions to ECS tasks
import * as iam from 'aws-cdk-lib/aws-iam';
// WAF for protecting the ALB
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
// AWS CloudWatch library — used to create alarms and monitor metrics
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
// AWS SNS (Simple Notification Service) — used to send notifications (email, SMS, etc.)
import * as sns from 'aws-cdk-lib/aws-sns';
// SNS subscriptions — allows adding subscribers (like email addresses) to the SNS topic
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
// CloudWatch Logs module to define custom log groups for ECS containers
import * as logs from 'aws-cdk-lib/aws-logs';

export class AwsInfraStack extends Stack {
    public readonly vpc: ec2.Vpc;
    public readonly ecsCluster: ecs.Cluster;
    public readonly database: rds.DatabaseInstance;

    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        // ------------------------
        // NETWORKING (VPC & Subnets)
        // ------------------------

        // Create a VPC with public and private subnets across 2 AZs
        this.vpc = new ec2.Vpc(this, 'AppVpc', {
            maxAzs: 2, // Spread across 2 Availability Zones
            natGateways: 1, // One NAT Gateway for private subnets to access internet
            subnetConfiguration: [
                {
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC, // Public subnet for load balancer/front
                    cidrMask: 24,
                },
                {
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, // Private subnet for backend/RDS
                    cidrMask: 24,
                },
            ],
        });

        // ------------------------
        // DATABASE (RDS + Secrets)
        // ------------------------

        //  Create a secret in Secrets Manager for PostgresSQL credentials
        const dbCredentialsSecret = new secretsManager.Secret(this, 'DbCredentialsSecret', {
            generateSecretString: {
                secretStringTemplate: JSON.stringify({username: 'postgres'}),
                generateStringKey: 'password', // Password will be auto-generated
                excludePunctuation: true, // Easier to copy/paste and fewer issues with special chars
            },
        });

        // Create the PostgresSQL RDS instance
        this.database = new rds.DatabaseInstance(this, 'PostgresInstance', {
            engine: rds.DatabaseInstanceEngine.postgres({version: rds.PostgresEngineVersion.VER_15_12}),
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),  // Cost-effective instance
            vpc: this.vpc, // Place DB into the created VPC
            vpcSubnets: {
                subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, // Place DB into private subnet
            },
            credentials: rds.Credentials.fromSecret(dbCredentialsSecret), // Use the secret for login
            allocatedStorage: 20, // Minimum 20 GB allocated
            maxAllocatedStorage: 100, // Can scale up to 100 GB
            databaseName: 'appdb', // Initial DB name
            multiAz: false, // Not highly available (cost saving for dev)
            publiclyAccessible: false, // No public IP — only internal access
            removalPolicy: RemovalPolicy.DESTROY, // Delete DB when stack is destroyed (dev only)
            deleteAutomatedBackups: true, // Don't keep backups
            backupRetention: Duration.days(0), // No backup retention
        });


        // ------------------------
        // ECS CLUSTER
        // ------------------------

        // Create ECS cluster in VPC
        this.ecsCluster = new ecs.Cluster(this, 'AppCluster', {
            vpc: this.vpc,
        });

        // ------------------------
        // LOG GROUPS (CloudWatch)
        // ------------------------

        const backendLogGroup = new logs.LogGroup(this, 'BackendLogGroup', {
            logGroupName: '/ecs/backend', // Custom name — appears in CloudWatch
            retention: logs.RetentionDays.ONE_WEEK, // auto-delete after 7 days
            removalPolicy: RemovalPolicy.DESTROY,   // Remove log group on stack delete (dev only)
        });

        const frontendLogGroup = new logs.LogGroup(this, 'FrontendLogGroup', {
            logGroupName: '/ecs/frontend',
            retention: logs.RetentionDays.ONE_WEEK, // auto-delete logs after 7 days
            removalPolicy: RemovalPolicy.DESTROY,   // destroy log group with stack (dev only)
        });

        // ------------------------
        // BACKEND (Fargate + ALB)
        // ------------------------

        // Create Fargate backend service with Application Load Balancer
        const backendService = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'BackendService', {
            cluster: this.ecsCluster, // ECS Cluster
            desiredCount: 1, // One running task
            cpu: 256, // CPU units (256 = 0.25 vCPU)
            memoryLimitMiB: 512, // Memory limit
            publicLoadBalancer: true, // Publicly accessible ALB (for API)

            taskImageOptions: {
                image: ecs.ContainerImage.fromRegistry('904907794166.dkr.ecr.eu-north-1.amazonaws.com/backend'),
                containerPort: 3000,
                environment: {
                    DB_NAME: 'appdb',
                    DB_HOST: this.database.dbInstanceEndpointAddress, // Internal RDS host
                    DB_PORT: this.database.dbInstanceEndpointPort,
                },
                // Pull DB credentials securely from Secrets Manager
                secrets: {
                    DB_USER: ecs.Secret.fromSecretsManager(dbCredentialsSecret, 'username'),
                    DB_PASSWORD: ecs.Secret.fromSecretsManager(dbCredentialsSecret, 'password'),
                },
                logDriver: ecs.LogDriver.awsLogs({
                    streamPrefix: 'backend',
                    logGroup: backendLogGroup,
                }),
            },
        });

        // Allow ECS to pull from ECR
        backendService.taskDefinition.obtainExecutionRole().addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly')
        );

        // Allow backend container to access RDS database on port 5432
        this.database.connections.allowFrom(
            backendService.service,
            ec2.Port.tcp(5432),
            'Allow backend ECS tasks to connect to PostgresSQL'
        );

        // ------------------------
        // WEB ACL (WAF for ALB)
        // ------------------------

        // Create a Web ACL (Web Access Control List) to protect the backend ALB
        const wafAcl = new wafv2.CfnWebACL(this, 'BackendWafAcl', {
            defaultAction: {allow: {}}, // Allow all traffic unless blocked by a rule
            scope: 'REGIONAL', // 'REGIONAL' must be used for ALBs (not 'CLOUDFRONT')
            visibilityConfig: {
                cloudWatchMetricsEnabled: true, // Enable CloudWatch metrics
                metricName: 'BackendWafMetrics', // Metric name prefix
                sampledRequestsEnabled: true, // Allow sampled request logging
            },
            rules: [
                {
                    name: 'AWS-AWSManagedRulesCommonRuleSet', // Use built-in rule set from AWS
                    priority: 0, // Priority of the rule (lower = higher priority)
                    overrideAction: {none: {}}, // Use rule’s default behavior
                    statement: {
                        managedRuleGroupStatement: {
                            vendorName: 'AWS',
                            name: 'AWSManagedRulesCommonRuleSet', // Common protection: SQLi, XSS, bad bots
                        },
                    },
                    visibilityConfig: {
                        cloudWatchMetricsEnabled: true,
                        metricName: 'CommonRuleSet',
                        sampledRequestsEnabled: true,
                    },
                },
            ],
        });

        // Associate the WAF ACL with the backend load balancer
        new wafv2.CfnWebACLAssociation(this, 'WafAssociation', {
            resourceArn: backendService.loadBalancer.loadBalancerArn, // ARN of the ALB
            webAclArn: wafAcl.attrArn, // ARN of the Web ACL
        });

        // ------------------------
        // FRONTEND (Fargate Task)
        // ------------------------

        const frontendSG = new ec2.SecurityGroup(this, 'FrontendSecurityGroup', {
            vpc: this.vpc,
            description: 'Allow HTTP access to frontend container',
            allowAllOutbound: true, // allow outbound to Internet (e.g. fetch from backend ALB)
        });

        // Allow HTTP (port 80) from anywhere (0.0.0.0/0)
        frontendSG.addIngressRule(
            ec2.Peer.anyIpv4(),                    // Allow connections from any IPv4 address (global access)
            ec2.Port.tcp(80),                 // Allow TCP traffic on port 80 (HTTP)
            'Allow HTTP from public'     // Description shown in AWS Console for the rule
        );

        // Create Fargate Task Definition for the frontend
        const frontendTaskDef = new ecs.FargateTaskDefinition(this, 'FrontendTaskDef', {
            cpu: 256, // 0.25 vCPU
            memoryLimitMiB: 512, // Memory allocation in MiB
        });

        // Add container to the task definition
        frontendTaskDef.addContainer('FrontendContainer', {
            image: ecs.ContainerImage.fromRegistry('904907794166.dkr.ecr.eu-north-1.amazonaws.com/frontend'), // Replace with your actual ECR image
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: 'frontend',         // log stream prefix (e.g. 'frontend/123456...')
                logGroup: frontendLogGroup,       // use fixed log group
            }),
        });

        new ecs.FargateService(this, 'FrontendService', {
            cluster: this.ecsCluster, // Place this service in the same ECS cluster
            taskDefinition: frontendTaskDef, // Use the task definition we just created
            desiredCount: 1, // Run one instance
            assignPublicIp: true, // Assign a public IP so it's accessible from the internet
            vpcSubnets: {
                subnetType: ec2.SubnetType.PUBLIC, // Run in public subnet (with internet access)
            },
            securityGroups: [frontendSG], // Attach the custom security group that allows inbound HTTP (port 80) traffic from the internet
        });

        // Allow ECS task to pull image from ECR
        frontendTaskDef.obtainExecutionRole().addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly')
        );

        // ------------------------
        // MONITORING (CloudWatch + SNS)
        // ------------------------

        // Create an SNS topic to receive alarm notifications
        const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
            displayName: 'Infra Alarms Topic',
        });

        // Subscribe via email
        alarmTopic.addSubscription(new subs.EmailSubscription('serhii.slavita@icloud.com'));

        // CloudWatch alarm for high CPU usage on backend ECS service
        const backendAlarm = new cw.Alarm(this, 'BackendHighCpu', {
            // configure metric with period inside
            metric: backendService.service.metricCpuUtilization({
                period: Duration.minutes(1), // Check CPU every 1 minute
            }),
            threshold: 70, // Alert if CPU > 70%
            evaluationPeriods: 2, // Must be above threshold for 2 consecutive periods
            datapointsToAlarm: 2, // How many data points must be breaching to trigger
            alarmDescription: 'CPU usage > 70% on backend',
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
            alarmName: 'BackendHighCpu',
        });

        backendAlarm.addAlarmAction({
            bind: () => ({alarmActionArn: alarmTopic.topicArn}),
        });

        // Create CloudWatch alarm for high RDS CPU usage
        const rdsCpuAlarm = new cw.Alarm(this, 'RdsHighCpu', {
            // Use metric from RDS and customize the period
            metric: this.database.metricCPUUtilization({
                period: Duration.minutes(1), // Check CPU every 1 minute
            }),
            threshold: 70, // Alert if CPU > 70%
            evaluationPeriods: 2, // Must be above threshold for 2 consecutive periods
            datapointsToAlarm: 2, // How many points must breach before triggering
            alarmDescription: 'CPU usage > 70% on RDS',
            comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
            alarmName: 'RdsHighCpu',
        });

        // Add SNS topic as an alarm action (notification)
        rdsCpuAlarm.addAlarmAction({
            bind: () => ({ alarmActionArn: alarmTopic.topicArn }), // Attach SNS topic to alarm
        });
    }
}
