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
                      phone_iccid: "8965030124051507851",
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
                        phone_iccid: "8965030124051507851",
                        phone_number: "+8613800138000",
                        content: "[京东] 验证码：654321"
                      },
                      {
                        phone_iccid: "8965030124051507852",
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
    "/api/control/devices": {
      post: {
        summary: "Synchronize modem reports",
        description: "Synchronize the daemon's normalized modem state with the dashboard",
        tags: ["Devices"],
        security: [{ ApiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                "$ref": "#/components/schemas/DeviceSyncRequest"
              }
            }
          }
        },
        responses: {
          "200": {
            description: "Device state synchronized successfully"
          },
          "400": {
            description: "Invalid synchronization payload",
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
        required: ["phone_iccid", "phone_number", "content"],
        properties: {
          id: {
            type: "string",
            description: "Message ID (auto-generated if not provided)",
            example: "msg-001"
          },
          phone_iccid: {
            type: "string",
            description: "Phone ICCID identifier",
            example: "8965030124051507851"
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
      ModemReport: {
        type: "object",
        required: ["equipment_id"],
        properties: {
          equipment_id: {
            type: "string",
            description: "Modem IMEI",
            example: "865827078383361"
          },
          detected_iccid: {
            type: "string",
            nullable: true,
            description: "ICCID read from the installed SIM"
          },
          detected_phone_number: {
            type: "string",
            nullable: true
          },
          detected_operator: {
            type: "string",
            nullable: true
          },
          modem_index: {
            type: "integer",
            example: 1
          },
          status: {
            type: "string",
            example: "active"
          },
          signal_percent: {
            type: "integer",
            minimum: 0,
            maximum: 100
          },
          rssi: {
            type: "number",
            nullable: true
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
      DeviceSyncRequest: {
        type: "object",
        required: ["modem_reports"],
        properties: {
          modem_reports: {
            type: "array",
            items: {
              "$ref": "#/components/schemas/ModemReport"
            }
          },
          sync_mode: {
            type: "string",
            enum: ["full", "incremental"],
            default: "incremental"
          },
          session_id: {
            type: "string",
            nullable: true
          },
          timestamp: {
            type: "string",
            format: "date-time"
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
