#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AwsInfraStack } from '../lib/aws-infra-stack';

const app = new cdk.App();

new AwsInfraStack(app, 'AwsInfraStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'eu-central-1',
  },
});