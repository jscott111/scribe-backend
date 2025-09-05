#!/bin/bash

# Cloud SQL Setup Script for Scribe
# This script helps you set up Cloud SQL and run migrations

set -e

echo "🚀 Setting up Cloud SQL for Scribe..."
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "❌ gcloud CLI not found. Please install it first:"
    echo "   https://cloud.google.com/sdk/docs/install"
    exit 1
fi

# Get project ID
PROJECT_ID=$(gcloud config get-value project)
if [ -z "$PROJECT_ID" ]; then
    echo "❌ No project ID found. Run: gcloud config set project YOUR_PROJECT_ID"
    exit 1
fi

echo "📋 Project ID: $PROJECT_ID"

# Check if Cloud SQL API is enabled
echo "🔌 Checking required APIs..."
if ! gcloud services list --enabled --filter="name:sqladmin.googleapis.com" --format="value(name)" | grep -q "sqladmin.googleapis.com"; then
    echo "   Enabling Cloud SQL Admin API..."
    gcloud services enable sqladmin.googleapis.com
else
    echo "✅ Cloud SQL Admin API is enabled"
fi

# Get instance details
echo ""
echo "📊 Please provide your Cloud SQL instance details:"
read -p "Instance ID (e.g., scribe-database): " INSTANCE_ID
read -p "Database name (e.g., scribe_prod): " DB_NAME
read -p "Database user (e.g., scribe_user): " DB_USER
read -s -p "Database password: " DB_PASSWORD
echo ""

# Get instance connection name
echo "🔍 Getting instance connection name..."
CONNECTION_NAME=$(gcloud sql instances describe $INSTANCE_ID --format="value(connectionName)" 2>/dev/null || echo "")

if [ -z "$CONNECTION_NAME" ]; then
    echo "❌ Instance '$INSTANCE_ID' not found. Please create it first:"
    echo "   gcloud sql instances create $INSTANCE_ID --database-version=POSTGRES_15 --tier=db-f1-micro --region=us-central1"
    exit 1
fi

echo "✅ Found instance: $CONNECTION_NAME"

# Get public IP
echo "🔍 Getting instance public IP..."
PUBLIC_IP=$(gcloud sql instances describe $INSTANCE_ID --format="value(ipAddresses[0].ipAddress)" 2>/dev/null || echo "")

if [ -z "$PUBLIC_IP" ]; then
    echo "❌ Could not get public IP for instance '$INSTANCE_ID'"
    exit 1
fi

echo "✅ Public IP: $PUBLIC_IP"

# Check if database exists
echo "🔍 Checking if database exists..."
if gcloud sql databases describe $DB_NAME --instance=$INSTANCE_ID &>/dev/null; then
    echo "✅ Database '$DB_NAME' exists"
else
    echo "📝 Creating database '$DB_NAME'..."
    gcloud sql databases create $DB_NAME --instance=$INSTANCE_ID
    echo "✅ Database created"
fi

# Check if user exists
echo "🔍 Checking if user exists..."
if gcloud sql users describe $DB_USER --instance=$INSTANCE_ID &>/dev/null; then
    echo "✅ User '$DB_USER' exists"
else
    echo "📝 Creating user '$DB_USER'..."
    gcloud sql users create $DB_USER --instance=$INSTANCE_ID --password=$DB_PASSWORD
    echo "✅ User created"
fi

# Download Cloud SQL Proxy
echo "📥 Downloading Cloud SQL Proxy..."
if [ ! -f "cloud_sql_proxy" ]; then
    curl -o cloud_sql_proxy https://dl.google.com/cloudsql/cloud_sql_proxy.linux.amd64
    chmod +x cloud_sql_proxy
    echo "✅ Cloud SQL Proxy downloaded"
else
    echo "✅ Cloud SQL Proxy already exists"
fi

# Start Cloud SQL Proxy in background
echo "🚀 Starting Cloud SQL Proxy..."
./cloud_sql_proxy -instances=$CONNECTION_NAME=tcp:5432 &
PROXY_PID=$!

# Wait for proxy to start
sleep 5

# Set environment variables
export DB_TYPE=postgres
export DB_HOST=127.0.0.1
export DB_PORT=5432
export DB_NAME=$DB_NAME
export DB_USER=$DB_USER
export DB_PASSWORD=$DB_PASSWORD
export DB_SSL=false

echo "🔧 Running database migrations..."

# Run migrations
node -e "
const { initDatabase } = require('./config/database-postgres');
initDatabase().then(() => {
  console.log('✅ Database initialized successfully!');
  process.exit(0);
}).catch(err => {
  console.error('❌ Error:', err);
  process.exit(1);
});
"

# Stop Cloud SQL Proxy
echo "🛑 Stopping Cloud SQL Proxy..."
kill $PROXY_PID 2>/dev/null || true

echo ""
echo "✅ Cloud SQL setup complete!"
echo ""
echo "📋 Connection Details:"
echo "   Instance: $INSTANCE_ID"
echo "   Database: $DB_NAME"
echo "   User: $DB_USER"
echo "   Public IP: $PUBLIC_IP"
echo "   Connection Name: $CONNECTION_NAME"
echo ""
echo "🔧 Environment Variables for Cloud Run:"
echo "   DB_TYPE=postgres"
echo "   DB_HOST=$PUBLIC_IP"
echo "   DB_PORT=5432"
echo "   DB_NAME=$DB_NAME"
echo "   DB_USER=$DB_USER"
echo "   DB_PASSWORD=$DB_PASSWORD"
echo "   DB_SSL=true"
echo ""
echo "🚀 Next steps:"
echo "   1. Set these environment variables in your Cloud Run service"
echo "   2. Deploy your application"
echo "   3. Test the connection"
