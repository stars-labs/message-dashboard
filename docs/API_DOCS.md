# 短信管理系统 API 接口文档

## 概述

本文档描述了短信验证码管理系统的后端API接口规范，用于与前端进行数据交互。

## 基础信息

- **Base URL**: `https://api.your-domain.com`
- **数据格式**: JSON
- **字符编码**: UTF-8
- **认证方式**: Bearer Token (可选)

## 数据模型

### PhoneNumber (手机号信息)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | SIM卡槽位唯一标识，如 "SIM_001" |
| number | string | 是 | 手机号码，国际格式，如 "+8613800138000" |
| country | string | 是 | 国家名称："中国"、"香港"、"新加坡" |
| flag | string | 是 | 国旗emoji："🇨🇳"、"🇭🇰"、"🇸🇬" |
| carrier | string | 是 | 运营商名称 |
| status | string | 是 | 在线状态："online" 或 "offline" |
| signal | number | 是 | 信号强度，范围 0-100 |

### Message (消息)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | string | 是 | 消息唯一ID |
| phoneId | string | 是 | 关联的SIM卡ID |
| phoneNumber | string | 是 | 手机号码 |
| content | string | 是 | 消息内容 |
| source | string | 是 | 来源应用名称 |
| timestamp | string | 是 | ISO 8601格式时间戳 |
| type | string | 是 | 消息类型："received" 或 "sent" |
| verificationCode | string | 否 | 自动提取的验证码 |
| recipient | string | 否 | 接收方号码（仅发送消息） |
| status | string | 否 | 发送状态（仅发送消息） |

## API 接口

### 1. 获取手机号列表

获取所有已配置的手机号信息。

**请求**
```http
GET /api/phones
```

**响应**
```json
{
  "success": true,
  "data": [
    {
      "id": "SIM_001",
      "number": "+8613800138000",
      "country": "中国",
      "flag": "🇨🇳",
      "carrier": "中国移动",
      "status": "online",
      "signal": 85
    },
    {
      "id": "SIM_002",
      "number": "+85291234567",
      "country": "香港",
      "flag": "🇭🇰",
      "carrier": "中国移动香港",
      "status": "online",
      "signal": 92
    }
  ]
}
```

### 2. 获取消息列表

获取接收和发送的消息记录。

**请求**
```http
GET /api/messages?phone_id={phoneId}&limit={limit}&offset={offset}
```

**参数**
| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| phone_id | string | 否 | 筛选指定手机号的消息 |
| limit | number | 否 | 返回数量限制，默认50，最大200 |
| offset | number | 否 | 分页偏移量，默认0 |

**响应**
```json
{
  "success": true,
  "data": [
    {
      "id": "msg-1234567890",
      "phoneId": "SIM_001",
      "phoneNumber": "+8613800138000",
      "content": "【淘宝】您的验证码是：123456，5分钟内有效。",
      "source": "淘宝",
      "timestamp": "2025-01-01T12:00:00Z",
      "type": "received",
      "verificationCode": "123456"
    }
  ],
  "pagination": {
    "total": 500,
    "limit": 50,
    "offset": 0
  }
}
```

### 3. 发送短信

通过指定的SIM卡发送短信。

**请求**
```http
POST /api/messages/send
Content-Type: application/json
```

**请求体**
```json
{
  "phoneId": "SIM_001",
  "recipient": "+8613900139000",
  "content": "测试短信内容"
}
```

**响应**
```json
{
  "success": true,
  "data": {
    "id": "msg-sent-1234567890",
    "phoneId": "SIM_001",
    "recipient": "+8613900139000",
    "content": "测试短信内容",
    "timestamp": "2025-01-01T12:00:00Z",
    "type": "sent",
    "status": "delivered"
  }
}
```

**错误响应**
```json
{
  "success": false,
  "error": {
    "code": "INVALID_PHONE_ID",
    "message": "指定的SIM卡不存在或离线"
  }
}
```

### 4. 获取统计信息

获取消息统计数据。

**请求**
```http
GET /api/stats
```

**响应**
```json
{
  "success": true,
  "data": {
    "total_messages": 5432,
    "today_messages": 234,
    "online_devices": 89,
    "total_devices": 95,
    "verification_rate": 0.98
  }
}
```

## WebSocket 实时通信

### 连接

```javascript
const ws = new WebSocket('wss://api.your-domain.com/ws');
```

### 消息格式

#### 新消息通知
```json
{
  "type": "new_message",
  "data": {
    "id": "msg-1234567890",
    "phoneId": "SIM_001",
    "phoneNumber": "+8613800138000",
    "content": "【京东】验证码：234567",
    "source": "京东",
    "timestamp": "2025-01-01T12:00:00Z",
    "type": "received",
    "verificationCode": "234567"
  }
}
```

#### 设备状态更新
```json
{
  "type": "device_status",
  "data": {
    "id": "SIM_001",
    "status": "offline",
    "signal": 0
  }
}
```

#### 发送状态更新
```json
{
  "type": "send_status",
  "data": {
    "messageId": "msg-sent-1234567890",
    "status": "delivered",
    "timestamp": "2025-01-01T12:00:00Z"
  }
}
```

## 验证码提取规则

后端应实现以下验证码提取规则：

1. **中文格式**
   - `验证码是：123456`
   - `验证码为123456`
   - `校验码123456`
   - `动态码：123456`

2. **英文格式**
   - `code is 123456`
   - `CODE: 123456`
   - `verification code: 123456`

3. **纯数字**
   - 4位数字：`1234`
   - 6位数字：`123456`

## 错误码

| 错误码 | 说明 |
|--------|------|
| INVALID_PHONE_ID | 无效的手机号ID |
| PHONE_OFFLINE | 手机号离线 |
| SEND_FAILED | 短信发送失败 |
| INVALID_RECIPIENT | 无效的接收方号码 |
| CONTENT_TOO_LONG | 短信内容过长 |
| RATE_LIMIT | 发送频率限制 |

## 注意事项

1. **时间格式**: 所有时间戳使用ISO 8601格式（UTC时间）
2. **手机号格式**: 使用E.164国际格式，包含国家代码
3. **字符限制**: 短信内容建议不超过500字符
4. **实时性**: WebSocket连接应保持心跳，建议30秒一次
5. **验证码安全**: 验证码提取后应考虑安全存储和访问控制