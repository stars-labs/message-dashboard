// Integration tests for MessageStore - SQLite persistence layer
use orange_pi_daemon_rust::message_store::MessageStore;
use orange_pi_daemon_rust::types::Message;

// Helper function to create test message
fn create_test_message(iccid: &str, content: &str, timestamp: &str) -> Message {
    Message {
        phone_iccid: iccid.to_string(),
        phone_number: "+1234567890".to_string(),
        content: content.to_string(),
        timestamp: timestamp.to_string(),
        direction: "received".to_string(),
    }
}

// ============================================================================
// Basic Storage Tests
// ============================================================================

#[test]
fn test_store_new_message() {
    let store = MessageStore::new(":memory:").unwrap();
    let msg = create_test_message("iccid_001", "Hello World", "2024-01-01T12:00:00.000Z");

    // First store should succeed
    let result = store.store_message(&msg, "modem_0", "at:1");
    assert!(result.is_ok());
    assert_eq!(result.unwrap(), true); // New message
}

#[test]
fn test_store_duplicate_message_same_timestamp() {
    let store = MessageStore::new(":memory:").unwrap();
    let msg = create_test_message("iccid_001", "Hello", "2024-01-01T12:00:00.000Z");

    // Store same message twice
    assert!(store.store_message(&msg, "modem_0", "at:1").unwrap());
    assert!(!store.store_message(&msg, "modem_0", "at:2").unwrap()); // Duplicate
}

#[test]
fn test_store_duplicate_within_10_seconds() {
    let store = MessageStore::new(":memory:").unwrap();

    let msg1 = create_test_message("iccid_001", "Test", "2024-01-01T12:00:00.000Z");
    let msg2 = create_test_message("iccid_001", "Test", "2024-01-01T12:00:05.000Z"); // 5 seconds later
    let msg3 = create_test_message("iccid_001", "Test", "2024-01-01T12:00:15.000Z"); // 15 seconds later

    assert!(store.store_message(&msg1, "modem_0", "at:1").unwrap());
    assert!(!store.store_message(&msg2, "modem_0", "at:2").unwrap()); // Within 10s - duplicate
    assert!(store.store_message(&msg3, "modem_0", "at:3").unwrap()); // After 10s - new
}

#[test]
fn test_store_different_content_same_iccid() {
    let store = MessageStore::new(":memory:").unwrap();

    let msg1 = create_test_message("iccid_001", "Message 1", "2024-01-01T12:00:00.000Z");
    let msg2 = create_test_message("iccid_001", "Message 2", "2024-01-01T12:00:00.000Z");

    assert!(store.store_message(&msg1, "modem_0", "at:1").unwrap());
    assert!(store.store_message(&msg2, "modem_0", "at:2").unwrap()); // Different content
}

#[test]
fn test_store_same_content_different_iccid() {
    let store = MessageStore::new(":memory:").unwrap();

    let msg1 = create_test_message("iccid_001", "Same message", "2024-01-01T12:00:00.000Z");
    let msg2 = create_test_message("iccid_002", "Same message", "2024-01-01T12:00:00.000Z");

    assert!(store.store_message(&msg1, "modem_0", "at:1").unwrap());
    assert!(store.store_message(&msg2, "modem_1", "at:1").unwrap()); // Different ICCID
}

// ============================================================================
// State Transition Tests
// ============================================================================

#[test]
fn test_get_pending_messages() {
    let store = MessageStore::new(":memory:").unwrap();

    // Store 3 messages
    let msg1 = create_test_message("iccid_001", "Msg 1", "2024-01-01T12:00:00.000Z");
    let msg2 = create_test_message("iccid_002", "Msg 2", "2024-01-01T12:01:00.000Z");
    let msg3 = create_test_message("iccid_003", "Msg 3", "2024-01-01T12:02:00.000Z");

    store.store_message(&msg1, "modem_0", "at:1").unwrap();
    store.store_message(&msg2, "modem_0", "at:2").unwrap();
    store.store_message(&msg3, "modem_0", "at:3").unwrap();

    // Get pending messages
    let pending = store.get_pending_messages(10).unwrap();
    assert_eq!(pending.len(), 3);
}

#[test]
fn test_get_pending_messages_with_limit() {
    let store = MessageStore::new(":memory:").unwrap();

    // Store 5 messages
    for i in 0..5 {
        let msg = create_test_message(
            &format!("iccid_{:03}", i),
            &format!("Message {}", i),
            &format!("2024-01-01T12:00:{:02}.000Z", i),
        );
        store.store_message(&msg, "modem_0", &format!("at:{}", i)).unwrap();
    }

    // Limit to 3
    let pending = store.get_pending_messages(3).unwrap();
    assert_eq!(pending.len(), 3);
}

#[test]
fn test_mark_uploading() {
    let store = MessageStore::new(":memory:").unwrap();

    let msg = create_test_message("iccid_001", "Test", "2024-01-01T12:00:00.000Z");
    store.store_message(&msg, "modem_0", "at:1").unwrap();

    let pending = store.get_pending_messages(10).unwrap();
    assert_eq!(pending.len(), 1);

    let ids: Vec<i64> = pending.iter().map(|(id, _)| *id).collect();
    store.mark_uploading(&ids).unwrap();

    // Should not appear in pending anymore (status is now 'uploading')
    let pending_after = store.get_pending_messages(10).unwrap();
    assert_eq!(pending_after.len(), 0);
}

#[test]
fn test_mark_uploaded() {
    let store = MessageStore::new(":memory:").unwrap();

    let msg = create_test_message("iccid_001", "Test", "2024-01-01T12:00:00.000Z");
    store.store_message(&msg, "modem_0", "at:1").unwrap();

    let pending = store.get_pending_messages(10).unwrap();
    let ids: Vec<i64> = pending.iter().map(|(id, _)| *id).collect();

    store.mark_uploading(&ids).unwrap();
    store.mark_uploaded(&ids).unwrap();

    // Should not appear in pending
    let pending_after = store.get_pending_messages(10).unwrap();
    assert_eq!(pending_after.len(), 0);
}

#[test]
fn test_mark_failed_and_retry() {
    let store = MessageStore::new(":memory:").unwrap();

    let msg = create_test_message("iccid_001", "Test", "2024-01-01T12:00:00.000Z");
    store.store_message(&msg, "modem_0", "at:1").unwrap();

    let pending = store.get_pending_messages(10).unwrap();
    let ids: Vec<i64> = pending.iter().map(|(id, _)| *id).collect();

    store.mark_uploading(&ids).unwrap();
    store.mark_failed(&ids, "Network error").unwrap();

    // Failed messages should reappear in pending (for retry)
    let pending_retry = store.get_pending_messages(10).unwrap();
    assert_eq!(pending_retry.len(), 1);
}

#[test]
fn test_failed_messages_retry_limit() {
    let store = MessageStore::new(":memory:").unwrap();

    let msg = create_test_message("iccid_001", "Test", "2024-01-01T12:00:00.000Z");
    store.store_message(&msg, "modem_0", "at:1").unwrap();

    // Fail 5 times (reaches retry limit)
    for _ in 0..5 {
        let pending = store.get_pending_messages(10).unwrap();
        if pending.is_empty() {
            break;
        }
        let ids: Vec<i64> = pending.iter().map(|(id, _)| *id).collect();
        store.mark_uploading(&ids).unwrap();
        store.mark_failed(&ids, "Test error").unwrap();
    }

    // After 5 attempts, should not appear in pending anymore
    let pending_final = store.get_pending_messages(10).unwrap();
    assert_eq!(pending_final.len(), 0);
}

// ============================================================================
// Multipart SMS Segment Tests
// ============================================================================

#[test]
fn test_store_single_segment() {
    let store = MessageStore::new(":memory:").unwrap();

    let result = store.store_segment(
        "iccid_001",
        "+1234567890",
        42, // ref_id
        3,  // total_parts
        1,  // part_number
        "Part 1 content",
        "2024-01-01T12:00:00.000Z",
        1,  // sms_index
    );

    assert!(result.is_ok());
}

#[test]
fn test_store_segment_preserves_sms_storage() {
    let store = MessageStore::new(":memory:").unwrap();

    store
        .store_segment_in_storage(
            "iccid_001",
            "+1234567890",
            42,
            2,
            1,
            "Part 1",
            "2024-01-01T12:00:00.000Z",
            "SM",
            7,
        )
        .unwrap();

    let segments = store
        .get_segments_with_storage("iccid_001", "+1234567890", 42, 2)
        .unwrap();
    assert_eq!(segments[0].3, "SM");
    assert_eq!(segments[0].4, 7);
}

#[test]
fn test_get_segments_incomplete() {
    let store = MessageStore::new(":memory:").unwrap();

    // Store parts 1 and 2 (out of 3)
    store.store_segment("iccid_001", "+1234567890", 42, 3, 1, "Part 1", "2024-01-01T12:00:00.000Z", 1).unwrap();
    store.store_segment("iccid_001", "+1234567890", 42, 3, 2, "Part 2", "2024-01-01T12:00:00.000Z", 2).unwrap();

    let segments = store.get_segments("iccid_001", "+1234567890", 42, 3).unwrap();
    assert_eq!(segments.len(), 2); // Still incomplete
}

#[test]
fn test_get_segments_complete() {
    let store = MessageStore::new(":memory:").unwrap();

    // Store all 3 parts
    store.store_segment("iccid_001", "+1234567890", 42, 3, 1, "Part 1", "2024-01-01T12:00:00.000Z", 1).unwrap();
    store.store_segment("iccid_001", "+1234567890", 42, 3, 2, "Part 2", "2024-01-01T12:00:00.000Z", 2).unwrap();
    store.store_segment("iccid_001", "+1234567890", 42, 3, 3, "Part 3", "2024-01-01T12:00:00.000Z", 3).unwrap();

    let segments = store.get_segments("iccid_001", "+1234567890", 42, 3).unwrap();
    assert_eq!(segments.len(), 3); // Complete

    // Verify parts are in correct order
    assert_eq!(segments[0].0, 1); // part_number
    assert_eq!(segments[1].0, 2);
    assert_eq!(segments[2].0, 3);
}

#[test]
fn test_segment_content_assembly() {
    let store = MessageStore::new(":memory:").unwrap();

    // Store parts out of order
    store.store_segment("iccid_001", "+1234567890", 42, 3, 3, "World!", "2024-01-01T12:00:00.000Z", 3).unwrap();
    store.store_segment("iccid_001", "+1234567890", 42, 3, 1, "Hello ", "2024-01-01T12:00:00.000Z", 1).unwrap();
    store.store_segment("iccid_001", "+1234567890", 42, 3, 2, "Rust ", "2024-01-01T12:00:00.000Z", 2).unwrap();

    let mut segments = store.get_segments("iccid_001", "+1234567890", 42, 3).unwrap();
    segments.sort_by_key(|(part_num, _, _, _)| *part_num);

    let combined: String = segments.iter().map(|(_, content, _, _)| content.as_str()).collect();
    assert_eq!(combined, "Hello Rust World!");
}

#[test]
fn test_delete_segments_after_assembly() {
    let store = MessageStore::new(":memory:").unwrap();

    // Store segments
    store.store_segment("iccid_001", "+1234567890", 42, 2, 1, "Part 1", "2024-01-01T12:00:00.000Z", 1).unwrap();
    store.store_segment("iccid_001", "+1234567890", 42, 2, 2, "Part 2", "2024-01-01T12:00:00.000Z", 2).unwrap();

    // Delete segments
    let deleted = store.delete_segments("iccid_001", 42).unwrap();
    assert_eq!(deleted, 2);

    // Verify deleted
    let segments = store.get_segments("iccid_001", "+1234567890", 42, 2).unwrap();
    assert_eq!(segments.len(), 0);
}

#[test]
fn test_multiple_multipart_messages_same_sender() {
    let store = MessageStore::new(":memory:").unwrap();

    // Message 1 (ref_id=10)
    store.store_segment("iccid_001", "+1234567890", 10, 2, 1, "Msg1 Part1", "2024-01-01T12:00:00.000Z", 1).unwrap();
    store.store_segment("iccid_001", "+1234567890", 10, 2, 2, "Msg1 Part2", "2024-01-01T12:00:00.000Z", 2).unwrap();

    // Message 2 (ref_id=20)
    store.store_segment("iccid_001", "+1234567890", 20, 2, 1, "Msg2 Part1", "2024-01-01T12:01:00.000Z", 3).unwrap();
    store.store_segment("iccid_001", "+1234567890", 20, 2, 2, "Msg2 Part2", "2024-01-01T12:01:00.000Z", 4).unwrap();

    // Retrieve separately
    let msg1 = store.get_segments("iccid_001", "+1234567890", 10, 2).unwrap();
    let msg2 = store.get_segments("iccid_001", "+1234567890", 20, 2).unwrap();

    assert_eq!(msg1.len(), 2);
    assert_eq!(msg2.len(), 2);
    assert!(msg1[0].1.contains("Msg1"));
    assert!(msg2[0].1.contains("Msg2"));
}

// ============================================================================
// Cleanup Tests
// ============================================================================

#[test]
fn test_cleanup_old_segments() {
    let store = MessageStore::new(":memory:").unwrap();

    // Store some segments
    store.store_segment("iccid_001", "+1234567890", 42, 2, 1, "Part 1", "2024-01-01T12:00:00.000Z", 1).unwrap();

    // Clean up segments older than 0 seconds (all of them)
    let result = store.cleanup_old_segments(0);
    assert!(result.is_ok()); // Should succeed
}

#[test]
fn test_cleanup_all_old_pending() {
    let store = MessageStore::new(":memory:").unwrap();

    // Store a message (will be old immediately in this test context)
    let msg = create_test_message("iccid_001", "Old message", "2024-01-01T12:00:00.000Z");
    store.store_message(&msg, "modem_0", "at:1").unwrap();

    // Since the message was just created, it won't be cleaned up yet
    // This tests the function signature and basic behavior
    let result = store.cleanup_all_old_pending();
    assert!(result.is_ok());
}

#[test]
fn test_mark_old_uploaded_as_deleted() {
    let store = MessageStore::new(":memory:").unwrap();

    let msg = create_test_message("iccid_001", "Test", "2024-01-01T12:00:00.000Z");
    store.store_message(&msg, "modem_0", "at:1").unwrap();

    let pending = store.get_pending_messages(10).unwrap();
    let ids: Vec<i64> = pending.iter().map(|(id, _)| *id).collect();
    store.mark_uploading(&ids).unwrap();
    store.mark_uploaded(&ids).unwrap();

    // Mark old uploaded messages as deleted
    let result = store.mark_old_uploaded_as_deleted();
    assert!(result.is_ok());
}

// ============================================================================
// Statistics Tests
// ============================================================================

#[test]
fn test_get_stats() {
    let store = MessageStore::new(":memory:").unwrap();

    // Store some messages
    let msg1 = create_test_message("iccid_001", "Msg 1", "2024-01-01T12:00:00.000Z");
    let msg2 = create_test_message("iccid_002", "Msg 2", "2024-01-01T12:01:00.000Z");

    store.store_message(&msg1, "modem_0", "at:1").unwrap();
    store.store_message(&msg2, "modem_0", "at:2").unwrap();

    let stats = store.get_stats().unwrap();
    assert_eq!(stats.pending, 2);
    assert_eq!(stats.uploading, 0);
    assert_eq!(stats.uploaded, 0);
    assert_eq!(stats.failed, 0);
}

#[test]
fn test_stats_after_upload() {
    let store = MessageStore::new(":memory:").unwrap();

    let msg = create_test_message("iccid_001", "Test", "2024-01-01T12:00:00.000Z");
    store.store_message(&msg, "modem_0", "at:1").unwrap();

    let pending = store.get_pending_messages(10).unwrap();
    let ids: Vec<i64> = pending.iter().map(|(id, _)| *id).collect();
    store.mark_uploading(&ids).unwrap();

    let stats = store.get_stats().unwrap();
    assert_eq!(stats.pending, 0);
    assert_eq!(stats.uploading, 1);

    store.mark_uploaded(&ids).unwrap();

    let stats_after = store.get_stats().unwrap();
    assert_eq!(stats_after.uploaded, 1);
}

// ============================================================================
// Edge Cases
// ============================================================================

#[test]
fn test_empty_content_handling() {
    let store = MessageStore::new(":memory:").unwrap();

    let msg = create_test_message("iccid_001", "", "2024-01-01T12:00:00.000Z");
    let result = store.store_message(&msg, "modem_0", "at:1");

    // Should handle empty content gracefully
    assert!(result.is_ok());
}

#[test]
fn test_long_content() {
    let store = MessageStore::new(":memory:").unwrap();

    let long_content = "x".repeat(1000); // 1000 chars
    let msg = create_test_message("iccid_001", &long_content, "2024-01-01T12:00:00.000Z");

    assert!(store.store_message(&msg, "modem_0", "at:1").is_ok());

    let pending = store.get_pending_messages(10).unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].1.content.len(), 1000);
}

#[test]
fn test_special_characters_in_content() {
    let store = MessageStore::new(":memory:").unwrap();

    let msg = create_test_message(
        "iccid_001",
        "你好世界 Hello 🌍 'quotes\" <tags>",
        "2024-01-01T12:00:00.000Z"
    );

    assert!(store.store_message(&msg, "modem_0", "at:1").is_ok());

    let pending = store.get_pending_messages(10).unwrap();
    assert_eq!(pending[0].1.content, "你好世界 Hello 🌍 'quotes\" <tags>");
}
