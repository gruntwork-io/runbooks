/**
 * Lambda function handler for the {{ .FunctionName }}-{{ .Environment }} function.
 */

/**
 * Main Lambda handler function.
 *
 * @param {Object} event - The event data passed to the Lambda function.
 *                         This could be from API Gateway, S3, SNS, CloudWatch Events, etc.
 * @param {Object} context - The Lambda runtime context object containing metadata
 *                           about the invocation, function, and execution environment.
 * @returns {Object} A response object with statusCode and body for API Gateway,
 *                   or any JSON-serializable object for other triggers.
 */
export const handler = async (event, context) => {
  const logLevel = process.env.LOG_LEVEL || 'INFO';
  
  // Log received event
  if (logLevel === 'DEBUG') {
    console.log('Received event:', JSON.stringify(event, null, 2));
  } else {
    console.log('Received event:', JSON.stringify(event));
  }

  // Extract request details if coming from API Gateway
  const httpMethod = event.httpMethod || 'N/A';
  const path = event.path || '/';
  const queryParams = event.queryStringParameters || {};
  let body = event.body;

  // Parse body if it's JSON
  if (body) {
    try {
      body = JSON.parse(body);
    } catch (e) {
      // Keep body as-is if not valid JSON
    }
  }

  // Log context information
  console.log(
    `Function: ${context.functionName}, Request ID: ${context.awsRequestId}, Remaining time: ${context.getRemainingTimeInMillis()}ms`
  );

  // Build response
  const responseBody = {
    message: `Hello from {{ .FunctionName }}-{{ .Environment }}!`,
    function_name: context.functionName,
    request_id: context.awsRequestId,
    environment: '{{ .Environment }}',
    event: event,
  };

  // Return API Gateway compatible response
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-Id': context.awsRequestId,
    },
    body: JSON.stringify(responseBody),
  };
};

