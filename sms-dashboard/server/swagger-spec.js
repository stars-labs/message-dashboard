export const swaggerSpec = {
  openapi: "3.0.0",
  info: {
    title: "SMS Dashboard Control API",
    description: "API for Orange Pi devices to upload SMS messages and phone status",
    version: "1.0.0",
    contact: {
      name: "API Support"
    }
  },
  servers: [
    {
      url: "https://sexy.qzz.io",
      description: "Production server"
    },
    {
      url: "https://sms-dashboard.xiongchenyu6.workers.dev",
      description: "Workers.dev server"
    }
  ],
  security: [
    {
      ApiKeyAuth: []
    }
  ],
  paths: {
    "/api/control/messages": {
      post: {
        summary: "Upload SMS Messages",
        description: "Upload one or more SMS messages from Orange Pi device",
        tags: ["Messages"],
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { 
                "$ref": "#/components/schemas/MessageUploadRequest" 
              },
              examples: {
                single: {
                  summary: "Single message",
                  value: {
                    messages: [{
                      phone_id: "SIM_001",
                      phone_number: "+8613800138000",
                      content: "[淘宝] 验证码123456，您正在登录，请勿告诉他人。",
                      source: "10690000",
                      timestamp: "2024-01-09T10:30:00Z"
                    }]
                  }
                },
                multiple: {
                  summary: "Multiple messages",
                  value: {
                    messages: [
                      {
                        phone_id: "SIM_001",
                        phone_number: "+8613800138000",
                        content: "[京东] 验证码：654321"
                      },
                      {
                        phone_id: "SIM_002",
                        phone_number: "+85298765432",
                        content: "Your WhatsApp code: 789012"
                      }
                    ]
                  }
                }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Messages uploaded successfully",
            content: {
              "application/json": {
                schema: { 
                  "$ref": "#/components/schemas/MessageUploadResponse" 
                }
              }
            }
          },
          "400": {
            description: "Bad request",
            content: {
              "application/json": {
                schema: {
                  "$ref": "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          "401": {
            description: "Unauthorized - Invalid or missing API key",
            content: {
              "application/json": {
                schema: {
                  "$ref": "#/components/schemas/ErrorResponse"
                }
              }
            }
          }
        }
      }
    },
    "/api/control/phones": {
      post: {
        summary: "Update Phone Status",
        description: "Update status and signal information for one or more phones",
        tags: ["Phones"],
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { 
                "$ref": "#/components/schemas/PhoneUpdateRequest" 
              },
              examples: {
                single: {
                  summary: "Single phone update",
                  value: {
                    phones: [{
                      id: "SIM_001",
                      status: "online",
                      signal: 85,
                      rssi: -44.0,
                      rsrq: -6.0,
                      rsrp: -70.0,
                      snr: 28.0
                    }]
                  }
                },
                multiple: {
                  summary: "Multiple phones",
                  value: {
                    phones: [
                      {
                        id: "SIM_001",
                        number: "+8613800138000",
                        country: "CN",
                        flag: "🇨🇳",
                        carrier: "中国移动",
                        status: "online",
                        signal: 85
                      },
                      {
                        id: "SIM_002",
                        status: "offline"
                      }
                    ]
                  }
                }
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Phone status updated successfully",
            content: {
              "application/json": {
                schema: { 
                  "$ref": "#/components/schemas/PhoneUpdateResponse" 
                }
              }
            }
          },
          "400": {
            description: "Bad request",
            content: {
              "application/json": {
                schema: {
                  "$ref": "#/components/schemas/ErrorResponse"
                }
              }
            }
          },
          "401": {
            description: "Unauthorized - Invalid or missing API key",
            content: {
              "application/json": {
                schema: {
                  "$ref": "#/components/schemas/ErrorResponse"
                }
              }
            }
          }
        }
      }
    }
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        in: "header",
        name: "X-API-Key",
        description: "API key for Orange Pi authentication"
      }
    },
    schemas: {
      Message: {
        type: "object",
        required: ["phone_id", "phone_number", "content"],
        properties: {
          id: { 
            type: "string", 
            description: "Message ID (auto-generated if not provided)",
            example: "msg-001" 
          },
          phone_id: { 
            type: "string", 
            description: "Phone/SIM identifier",
            example: "SIM_001" 
          },
          phone_number: { 
            type: "string", 
            description: "Phone number in E.164 format",
            example: "+8613800138000" 
          },
          content: { 
            type: "string", 
            description: "SMS message content",
            example: "[淘宝] 验证码123456，您正在登录，请勿告诉他人。" 
          },
          source: { 
            type: "string", 
            description: "Sender number or name",
            example: "10690000" 
          },
          timestamp: { 
            type: "string", 
            format: "date-time",
            description: "Message timestamp in ISO 8601 format",
            example: "2024-01-09T10:30:00Z"
          }
        }
      },
      Phone: {
        type: "object",
        required: ["id", "status"],
        properties: {
          id: { 
            type: "string", 
            description: "Phone/SIM identifier",
            example: "SIM_001" 
          },
          number: { 
            type: "string", 
            description: "Phone number in E.164 format",
            example: "+8613800138000" 
          },
          country: { 
            type: "string", 
            description: "Country code (ISO 3166-1 alpha-2)",
            example: "CN" 
          },
          flag: { 
            type: "string", 
            description: "Country flag emoji",
            example: "🇨🇳" 
          },
          carrier: { 
            type: "string", 
            description: "Mobile carrier name",
            example: "中国移动" 
          },
          status: { 
            type: "string", 
            enum: ["online", "offline", "error"],
            description: "Phone status",
            example: "online" 
          },
          signal: { 
            type: "integer", 
            minimum: 0,
            maximum: 100,
            description: "Signal strength percentage",
            example: 85 
          },
          iccid: { 
            type: "string", 
            description: "SIM card ICCID",
            example: "89860000000000000000" 
          },
          rssi: { 
            type: "number", 
            description: "Received Signal Strength Indicator in dBm",
            example: -44.0 
          },
          rsrq: { 
            type: "number", 
            description: "Reference Signal Received Quality in dB",
            example: -6.0 
          },
          rsrp: { 
            type: "number", 
            description: "Reference Signal Received Power in dBm",
            example: -70.0 
          },
          snr: { 
            type: "number", 
            description: "Signal-to-Noise Ratio in dB",
            example: 28.0 
          }
        }
      },
      MessageUploadRequest: {
        type: "object",
        required: ["messages"],
        properties: {
          messages: {
            type: "array",
            items: {
              "$ref": "#/components/schemas/Message"
            },
            minItems: 1,
            maxItems: 50,
            description: "Array of messages to upload (max 50 per request)"
          }
        }
      },
      PhoneUpdateRequest: {
        type: "object",
        required: ["phones"],
        properties: {
          phones: {
            type: "array",
            items: {
              "$ref": "#/components/schemas/Phone"
            },
            minItems: 1,
            description: "Array of phones to update"
          }
        }
      },
      MessageUploadResponse: {
        type: "object",
        properties: {
          success: { 
            type: "boolean",
            example: true 
          },
          processed: { 
            type: "integer",
            description: "Number of messages processed",
            example: 1 
          },
          message: { 
            type: "string",
            example: "Successfully uploaded 1 messages" 
          }
        }
      },
      PhoneUpdateResponse: {
        type: "object",
        properties: {
          success: { 
            type: "boolean",
            example: true 
          },
          updated: { 
            type: "integer",
            description: "Number of phones updated",
            example: 1 
          },
          message: { 
            type: "string",
            example: "Successfully updated 1 phones" 
          }
        }
      },
      ErrorResponse: {
        type: "object",
        properties: {
          success: { 
            type: "boolean",
            example: false 
          },
          error: { 
            type: "string",
            description: "Error message",
            example: "Unauthorized" 
          }
        }
      }
    }
  }
};