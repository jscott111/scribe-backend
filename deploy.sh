#!/bin/bash

# Deploy script for Google Cloud Run
# Usage: ./deploy.sh [PROJECT_ID]

set -e

# Get project ID from argument or gcloud config
PROJECT_ID=${1:-$(gcloud config get-value project)}

if [ -z "$PROJECT_ID" ]; then
    echo "❌ No project ID provided. Usage: ./deploy.sh [PROJECT_ID]"
    echo "   Or set default project: gcloud config set project YOUR_PROJECT_ID"
    exit 1
fi

echo "🚀 Deploying to project: $PROJECT_ID"

# Enable required APIs
echo "📋 Enabling required APIs..."
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
gcloud services enable containerregistry.googleapis.com

# Submit build to Cloud Build (will get env vars from Cloud Run service)
echo "🔨 Building and deploying with database migrations..."
echo "📊 Will use environment variables from existing Cloud Run service"
gcloud builds submit --config cloudbuild.yaml --project $PROJECT_ID

# Get the service URL
SERVICE_URL=$(gcloud run services describe scribe-backend --region=us-central1 --project=$PROJECT_ID --format='value(status.url)')

echo "✅ Deployment complete!"
echo "🌐 Service URL: $SERVICE_URL"
echo "🔍 Health check: $SERVICE_URL/api/health"

# Test the deployment
echo "🧪 Testing deployment..."
curl -s "$SERVICE_URL/api/health" | jq . || echo "❌ Health check failed"

echo ""
echo "📝 Next steps:"
echo "1. Update your frontend CORS_ORIGIN to include: $SERVICE_URL"
echo "2. Set environment variables in Cloud Run console:"
echo "   - JWT_SECRET"
echo "   - AZURE_TRANSLATOR_KEY" 
echo "   - AZURE_TRANSLATOR_REGION"
echo "   - CORS_ORIGIN (your frontend domains)"
echo "   - DB_HOST (your Cloud SQL public IP)"
echo "   - DB_PASSWORD (your database password)"
echo ""
echo "💡 Database variables are automatically retrieved from your Cloud Run service"
echo "   Make sure to set these in Cloud Run console first:"
echo "   - DB_HOST (your Cloud SQL public IP)"
echo "   - DB_PASSWORD (your database password)"
echo "   - DB_PORT (5432)"
echo "   - DB_NAME (scribe_prod)"
echo "   - DB_USER (scribe_user)"
