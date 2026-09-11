/** Minimal OpenAPI spec for P1. Expands as modules land (or swap to swagger-jsdoc). */
export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "SEIKA Gaming Zone OS API",
    version: "0.1.0",
    description: "Backend monolith — auth, zones, sessions, wallet, XP, shop.",
  },
  servers: [{ url: "/", description: "current host" }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
    },
  },
  paths: {
    "/health": {
      get: { tags: ["System"], summary: "Liveness + DB connectivity", responses: { "200": { description: "OK" } } },
    },
    "/api/auth/otp/request": {
      post: {
        tags: ["Auth"],
        summary: "Request an OTP",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["identifier"],
                properties: {
                  identifier: { type: "string", example: "9876543210" },
                  audience: { type: "string", enum: ["player", "staff"], default: "player" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "OTP issued (dev returns devCode)" } },
      },
    },
    "/api/auth/otp/verify": {
      post: {
        tags: ["Auth"],
        summary: "Verify OTP → tokens",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["identifier", "code"],
                properties: {
                  identifier: { type: "string", example: "9876543210" },
                  code: { type: "string", example: "123456" },
                  audience: { type: "string", enum: ["player", "staff"], default: "player" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "accessToken + refreshToken" } },
      },
    },
    "/api/auth/refresh": {
      post: { tags: ["Auth"], summary: "Rotate refresh token", responses: { "200": { description: "new token pair" } } },
    },
    "/api/auth/me": {
      get: { tags: ["Auth"], summary: "Current claims", security: [{ bearerAuth: [] }], responses: { "200": { description: "claims" } } },
    },
    "/api/auth/logout": {
      post: { tags: ["Auth"], summary: "Revoke refresh tokens", security: [{ bearerAuth: [] }], responses: { "200": { description: "OK" } } },
    },
  },
} as const;
