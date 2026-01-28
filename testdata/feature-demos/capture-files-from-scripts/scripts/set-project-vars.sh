#!/bin/bash
# Set project configuration variables
# These will be used by subsequent scripts to generate customized files

echo "Configuring project variables..."
echo ""

# Project identification
export PROJECT_NAME="acme-web-app"
export ENVIRONMENT="staging"

# Infrastructure settings
export AWS_REGION="us-west-2"
export AWS_ACCOUNT_ID="123456789012"

# Team information
export TEAM_EMAIL="platform-team@acme.com"
export COST_CENTER="engineering-platform"

# Application settings
export APP_PORT="8080"
export REPLICA_COUNT="3"

echo "Project variables configured:"
echo ""
echo "  📦 Project:     $PROJECT_NAME"
echo "  🌍 Environment: $ENVIRONMENT"
echo "  🗺️  Region:      $AWS_REGION"
echo "  📧 Team:        $TEAM_EMAIL"
echo "  💰 Cost Center: $COST_CENTER"
echo "  🔌 App Port:    $APP_PORT"
echo "  📋 Replicas:    $REPLICA_COUNT"
echo ""
echo "These variables will be used to generate configuration files in the next step."
