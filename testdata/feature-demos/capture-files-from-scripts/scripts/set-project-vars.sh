#!/usr/bin/env bash
# Set project configuration variables
# Subsequent scripts read them to generate customized files

echo "Configuring project variables..."
echo ""

PROJECT_NAME="acme-web-app"
ENVIRONMENT="staging"
AWS_REGION="us-west-2"
AWS_ACCOUNT_ID="123456789012"
TEAM_EMAIL="platform-team@acme.com"
COST_CENTER="engineering-platform"
APP_PORT="8080"
REPLICA_COUNT="3"

# Set them in the session, for the scripts after this one
cat >> "$RUNBOOK_ENV" <<EOF
PROJECT_NAME=$PROJECT_NAME
ENVIRONMENT=$ENVIRONMENT
AWS_REGION=$AWS_REGION
AWS_ACCOUNT_ID=$AWS_ACCOUNT_ID
TEAM_EMAIL=$TEAM_EMAIL
COST_CENTER=$COST_CENTER
APP_PORT=$APP_PORT
REPLICA_COUNT=$REPLICA_COUNT
EOF

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
