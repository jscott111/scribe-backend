# Google Translation Service Testing & Monitoring Guide

## Overview
This guide helps you diagnose and test Google Cloud Translation API connection issues. The service now includes:
- Automatic retry logic with exponential backoff
- Client health checks and automatic recreation
- Comprehensive logging
- Health check endpoints
- Statistics tracking

## Health Check Endpoints

### 1. Basic Health Check
```bash
curl http://localhost:3000/health
```

### 2. Translation Service Health Check
```bash
curl http://localhost:3000/health/translation
```

This endpoint tests the translation service and returns:
- `healthy`: Boolean indicating if service is working
- `hasClient`: Whether a client instance exists
- `clientAge`: Age of current client in seconds
- `errorCount`: Number of errors since startup
- `successCount`: Number of successful translations
- `errorRate`: Percentage of failed requests
- `testTranslation`: Result of a test translation (en -> fr)
- `lastError`: Details of last error if any

### 3. Translation Service Statistics
```bash
curl http://localhost:3000/api/translation/stats
```

Returns current statistics:
- Error/success counts
- Error rate
- Last error details
- Client age

## Logging

### Translation Request Logs
Each translation request is logged with a unique ID:

**Successful Translation:**
```
🌐 [trans-1234567890-abc123] Starting translation: en-US -> fr-FR, text length: 45
✅ [trans-1234567890-abc123] Translation completed in 234ms: "Bonjour, comment allez-vous..."
```

**Failed Translation (with retries):**
```
🌐 Translating from en-US (en) to fr-FR (fr): "Hello, how are you..."
❌ Translation error (attempt 1/4, 5000ms): { message: 'UNAVAILABLE', code: 14, isRetryable: true, willRetry: true }
⏳ Retrying translation in 1000ms...
[Retry 1/3] 🌐 Translating from en-US (en) to fr-FR (fr): "Hello, how are you..."
✅ Translation successful (8500ms): "Bonjour, comment allez-vous..."
```

**Client Recreation:**
```
🔄 Recreating Translation client... { forceRecreate: false, hasClient: true, clientAge: '1800s', errorCount: 6 }
✅ Translation client created successfully
```

### Error Types Logged

1. **Network/Timeout Errors:**
   - `UNAVAILABLE` (code 14)
   - `DEADLINE_EXCEEDED` (code 4)
   - `timeout` messages

2. **Authentication Errors:**
   - `UNAUTHENTICATED` (code 16)
   - Credential issues

3. **Quota/Rate Limit Errors:**
   - `RESOURCE_EXHAUSTED` (code 8)
   - Rate limit messages

## Testing Scenarios

### Test 1: Basic Translation Test
```bash
# Test a simple translation via the health endpoint
curl http://localhost:3000/health/translation | jq '.health.testTranslation'
```

### Test 2: Monitor Translation Calls During Active Session
Watch the server logs while a speaker is active:
```bash
# Filter for translation logs
tail -f server.log | grep -E "(🌐|✅|❌|🔄).*translation|Translation"
```

### Test 3: Force Client Recreation
If you suspect the client is stale, you can trigger recreation by:
1. Making multiple failed requests (will auto-recreate after 5 errors)
2. Waiting 30 minutes (automatic refresh)
3. Restarting the server

### Test 4: Simulate Network Issues
Monitor how the service handles failures:
```bash
# Watch error handling
tail -f server.log | grep -E "Translation error|Retrying|Recreating"
```

## Monitoring Checklist

### During Active Sessions

1. **Check Health Status:**
   ```bash
   curl http://localhost:3000/health/translation | jq '.healthy'
   ```

2. **Monitor Error Rate:**
   ```bash
   curl http://localhost:3000/api/translation/stats | jq '.errorRate'
   ```
   - Should be < 5% under normal conditions
   - If > 10%, investigate connection issues

3. **Check Client Age:**
   ```bash
   curl http://localhost:3000/health/translation | jq '.health.clientAge'
   ```
   - Client refreshes every 30 minutes automatically
   - If client is very old (> 1 hour) and errors are occurring, force recreation

4. **Watch for Retry Patterns:**
   - Look for multiple retry attempts in logs
   - Check if retries eventually succeed
   - If all retries fail, check network/credentials

### When Listener Disconnects

1. **Check Translation Service Health:**
   ```bash
   curl http://localhost:3000/health/translation
   ```

2. **Review Recent Errors:**
   ```bash
   tail -n 100 server.log | grep -E "Translation error|translation"
   ```

3. **Check Error Count:**
   ```bash
   curl http://localhost:3000/api/translation/stats | jq '.errorCount'
   ```

4. **Verify Client Status:**
   ```bash
   curl http://localhost:3000/health/translation | jq '.health.hasClient, .health.clientAge'
   ```

## Common Issues & Solutions

### Issue: Translation Service Unavailable
**Symptoms:**
- Health check returns `healthy: false`
- Error code 14 (UNAVAILABLE)
- Multiple retry attempts

**Solutions:**
1. Check Google Cloud project status
2. Verify credentials are valid
3. Check network connectivity
4. Service will auto-retry with exponential backoff

### Issue: Client Stale/Not Reconnecting
**Symptoms:**
- Client age > 1 hour
- Errors persist despite retries
- Health check fails

**Solutions:**
1. Client auto-recreates after 30 minutes
2. Force recreation by restarting server
3. Client recreates after 5 consecutive errors

### Issue: High Error Rate
**Symptoms:**
- Error rate > 10%
- Many failed translations
- Listeners not receiving translations

**Solutions:**
1. Check Google Cloud quotas
2. Verify API is enabled
3. Check for rate limiting
4. Review error details in logs

### Issue: Timeout Errors
**Symptoms:**
- "Translation request timeout" messages
- Slow response times

**Solutions:**
1. Default timeout is 30 seconds
2. Check network latency
3. Verify Google Cloud service status
4. Service will retry automatically

## Debugging Commands

### Real-time Monitoring
```bash
# Watch all translation-related logs
tail -f server.log | grep -i translation

# Watch for errors only
tail -f server.log | grep -E "❌.*Translation|Translation error"

# Watch for client recreation
tail -f server.log | grep -E "Recreating|client created"
```

### Check Service Status
```bash
# Quick health check
curl -s http://localhost:3000/health/translation | jq '.healthy, .health.errorRate, .health.clientAge'

# Detailed stats
curl -s http://localhost:3000/api/translation/stats | jq
```

### Test Translation Directly
You can test translation by making a request to the translation endpoint (if exposed) or by:
1. Starting a speaker session
2. Speaking some text
3. Watching logs for translation calls
4. Checking if listeners receive translations

## Configuration

### Retry Settings
- `MAX_RETRIES`: 3 attempts
- `RETRY_DELAY_BASE`: 1000ms (exponential backoff: 1s, 2s, 4s)
- `CLIENT_REFRESH_INTERVAL`: 30 minutes
- `TIMEOUT`: 30 seconds per request

### Health Check Settings
- Health check runs every 5 minutes
- Auto-recreates client if error count > 10
- Auto-recreates client if last error > 1 minute ago

## Best Practices

1. **Monitor Health Endpoint Regularly:**
   - Set up alerts for `healthy: false`
   - Monitor error rate trends
   - Track client age

2. **Review Logs:**
   - Check for retry patterns
   - Monitor error codes
   - Watch for client recreation events

3. **Proactive Monitoring:**
   - Check health before important sessions
   - Monitor during high-traffic periods
   - Set up automated health checks

4. **When Issues Occur:**
   - Check health endpoint first
   - Review recent logs
   - Verify Google Cloud status
   - Check error statistics

## Force Client Recreation

If you need to force client recreation immediately:

1. **Via Error Count:**
   - Make 5+ failed requests (will trigger auto-recreation)

2. **Via Restart:**
   - Restart the server (cleanest method)

3. **Via Code:**
   - Call `googleTranslationService.getTranslationClient(true)` with `forceRecreate: true`

## Additional Notes

- The service uses exponential backoff for retries
- Client automatically refreshes every 30 minutes
- Health checks run every 5 minutes
- All translation requests are logged with unique IDs for tracking
- Error details include codes, messages, and timestamps for debugging

