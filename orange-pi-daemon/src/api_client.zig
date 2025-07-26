const std = @import("std");
const http = std.http;
const json = std.json;
const types = @import("types.zig");

const Config = types.Config;
const Message = types.Message;
const Phone = types.Phone;
const MessageUploadRequest = types.MessageUploadRequest;
const PhoneUpdateRequest = types.PhoneUpdateRequest;

pub const ApiClient = struct {
    allocator: std.mem.Allocator,
    config: Config,
    client: http.Client,

    pub fn init(allocator: std.mem.Allocator, config: Config) ApiClient {
        return .{
            .allocator = allocator,
            .config = config,
            .client = http.Client{ .allocator = allocator },
        };
    }

    pub fn deinit(self: *ApiClient) void {
        self.client.deinit();
    }

    pub fn uploadMessages(self: *ApiClient, messages: []const Message) !void {
        if (messages.len == 0) return;

        const request_body = MessageUploadRequest{ .messages = messages };
        const json_body = try json.stringifyAlloc(self.allocator, request_body, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(json_body);

        const url = try std.fmt.allocPrint(self.allocator, "{s}/api/control/messages", .{self.config.api_url});
        defer self.allocator.free(url);

        const uri = try std.Uri.parse(url);

        var server_header_buffer: [16384]u8 = undefined;
        var request = try self.client.open(.POST, uri, .{
            .server_header_buffer = &server_header_buffer,
            .extra_headers = &[_]http.Header{
                .{ .name = "X-API-Key", .value = self.config.api_key },
                .{ .name = "Content-Type", .value = "application/json" },
            },
            .keep_alive = false,
        });
        defer request.deinit();

        request.transfer_encoding = .{ .content_length = json_body.len };
        try request.send();
        try request.writeAll(json_body);
        try request.finish();
        try request.wait();

        if (request.response.status != .ok) {
            std.log.err("Failed to upload messages: {}", .{request.response.status});
            return error.UploadFailed;
        }
    }

    pub fn updatePhones(self: *ApiClient, phones: []const Phone) !void {
        if (phones.len == 0) return;

        const request_body = PhoneUpdateRequest{ .phones = phones };
        const json_body = try json.stringifyAlloc(self.allocator, request_body, .{ .emit_null_optional_fields = false });
        defer self.allocator.free(json_body);

        const url = try std.fmt.allocPrint(self.allocator, "{s}/api/control/phones", .{self.config.api_url});
        defer self.allocator.free(url);

        const uri = try std.Uri.parse(url);

        var server_header_buffer: [16384]u8 = undefined;
        var request = try self.client.open(.POST, uri, .{
            .server_header_buffer = &server_header_buffer,
            .extra_headers = &[_]http.Header{
                .{ .name = "X-API-Key", .value = self.config.api_key },
                .{ .name = "Content-Type", .value = "application/json" },
            },
            .keep_alive = false,
        });
        defer request.deinit();

        request.transfer_encoding = .{ .content_length = json_body.len };
        try request.send();
        try request.writeAll(json_body);
        try request.finish();
        try request.wait();

        if (request.response.status != .ok) {
            std.log.err("Failed to update phones: {}", .{request.response.status});
            return error.UpdateFailed;
        }
    }
};