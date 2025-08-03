exports.handler = function (event, context, callback) {
  const name = event.queryStringParameters.name || "World";
  return {
    statusCode: 200,
    body: `Hello, ${name}`,
  };
};