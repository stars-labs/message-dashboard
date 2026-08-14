//! SMS assembler - buffers multipart SMS messages and assembles them when complete

use crate::at_modem::AtSms;
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tracing::{debug, warn};

/// Key to identify messages that belong together
#[derive(Debug, Hash, Eq, PartialEq, Clone)]
struct MessageGroupKey {
    iccid: String,
    sender: String,
    ref_id: u8,
    total_parts: u8,
}

/// Buffered message part
#[derive(Debug, Clone)]
struct MessagePart {
    part_number: u8,
    content: String,
    timestamp: String,
    index: u32, // SIM storage index for deletion
    received_at: Instant,
}

/// Assembled complete message
#[derive(Debug, Clone)]
pub struct AssembledMessage {
    pub content: String, // Combined text from all parts
    pub sender: String,
    pub timestamp: String,     // Use first part's timestamp
    pub sms_indices: Vec<u32>, // All SIM indices for deletion
}

/// SMS assembler that buffers multipart messages until all parts arrive
pub struct SmsAssembler {
    /// In-memory buffer: groups -> parts
    buffer: HashMap<MessageGroupKey, Vec<MessagePart>>,
    /// Timeout for incomplete messages (5 minutes)
    timeout: Duration,
}

impl SmsAssembler {
    /// Create a new SMS assembler with 5-minute timeout
    pub fn new() -> Self {
        SmsAssembler {
            buffer: HashMap::new(),
            timeout: Duration::from_secs(300), // 5 minutes
        }
    }

    /// Add a message part to the buffer
    /// Returns Some(AssembledMessage) if all parts are now complete, or if it's a single-part message
    pub fn add_part(&mut self, sms: AtSms, iccid: String) -> Option<AssembledMessage> {
        // If no concat info, return as single message immediately
        let concat_info = match &sms.concat_info {
            Some(info) => info,
            None => {
                // Single-part message - return immediately
                return Some(AssembledMessage {
                    content: sms.text,
                    sender: sms.sender,
                    timestamp: sms.timestamp,
                    sms_indices: vec![sms.index],
                });
            }
        };

        let key = MessageGroupKey {
            iccid: iccid.clone(),
            sender: sms.sender.clone(),
            ref_id: concat_info.ref_id,
            total_parts: concat_info.total_parts,
        };

        let part = MessagePart {
            part_number: concat_info.part_number,
            content: sms.text,
            timestamp: sms.timestamp,
            index: sms.index,
            received_at: Instant::now(),
        };

        debug!(
            "Buffering message part {}/{} (ref_id={}, sender={}, iccid={})",
            part.part_number, concat_info.total_parts, concat_info.ref_id, sms.sender, iccid
        );

        // Add to buffer
        let parts = self.buffer.entry(key.clone()).or_insert_with(Vec::new);

        // Check for duplicate part numbers
        if parts.iter().any(|p| p.part_number == part.part_number) {
            warn!(
                "Duplicate part {} for ref_id={} - skipping",
                part.part_number, concat_info.ref_id
            );
            return None;
        }

        parts.push(part);

        // Check if complete
        if parts.len() == concat_info.total_parts as usize {
            // All parts received - assemble!
            debug!(
                "All {} parts received for ref_id={} - assembling",
                parts.len(),
                concat_info.ref_id
            );
            return self.assemble_and_remove(&key);
        }

        debug!(
            "Waiting for more parts: {}/{} received for ref_id={}",
            parts.len(),
            concat_info.total_parts,
            concat_info.ref_id
        );
        None
    }

    /// Assemble complete message and remove from buffer
    fn assemble_and_remove(&mut self, key: &MessageGroupKey) -> Option<AssembledMessage> {
        let parts = self.buffer.remove(key)?;

        // Sort by part number
        let mut sorted_parts = parts;
        sorted_parts.sort_by_key(|p| p.part_number);

        // Combine content
        let content = sorted_parts
            .iter()
            .map(|p| p.content.as_str())
            .collect::<Vec<_>>()
            .join("");

        // Use first part's timestamp as canonical
        let timestamp = sorted_parts[0].timestamp.clone();
        let sender = key.sender.clone();
        let sms_indices: Vec<u32> = sorted_parts.iter().map(|p| p.index).collect();

        debug!(
            "Assembled multipart message: {} parts, {} chars, indices: {:?}",
            sorted_parts.len(),
            content.len(),
            sms_indices
        );

        Some(AssembledMessage {
            content,
            sender,
            timestamp,
            sms_indices,
        })
    }

    /// Remove expired incomplete messages (>5 minutes old)
    /// Returns expired parts as individual messages (fallback behavior)
    pub fn cleanup_expired(&mut self) -> Vec<AssembledMessage> {
        let now = Instant::now();
        let mut expired = Vec::new();

        self.buffer.retain(|key, parts| {
            let oldest = parts.iter().map(|p| p.received_at).min().unwrap();
            if now.duration_since(oldest) > self.timeout {
                // Timeout - convert parts to individual messages
                warn!(
                    "Multipart message timeout for ref_id={}, sender={} ({}/{} parts received) - uploading parts individually",
                    key.ref_id, key.sender, parts.len(), key.total_parts
                );
                for part in parts {
                    expired.push(AssembledMessage {
                        content: part.content.clone(),
                        sender: key.sender.clone(),
                        timestamp: part.timestamp.clone(),
                        sms_indices: vec![part.index],
                    });
                }
                false  // Remove from buffer
            } else {
                true  // Keep
            }
        });

        if !expired.is_empty() {
            debug!("Cleaned up {} expired message parts", expired.len());
        }

        expired
    }

    /// Get count of buffered message groups
    pub fn pending_count(&self) -> usize {
        self.buffer.len()
    }

    /// Get count of buffered parts
    pub fn pending_parts_count(&self) -> usize {
        self.buffer.values().map(|v| v.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::at_modem::{AtSms, ConcatInfo};

    fn make_test_sms(index: u32, part_num: u8, total: u8, ref_id: u8, text: &str) -> AtSms {
        AtSms {
            storage: "ME".to_string(),
            index,
            part_indices: vec![index],
            sender: "+1234567890".to_string(),
            timestamp: "2024-01-01T00:00:00.000Z".to_string(),
            text: text.to_string(),
            concat_info: Some(ConcatInfo {
                ref_id,
                total_parts: total,
                part_number: part_num,
            }),
        }
    }

    #[test]
    fn test_single_part_message() {
        let mut assembler = SmsAssembler::new();
        let sms = AtSms {
            storage: "ME".to_string(),
            index: 1,
            part_indices: vec![1],
            sender: "+1234567890".to_string(),
            timestamp: "2024-01-01T00:00:00.000Z".to_string(),
            text: "Hello".to_string(),
            concat_info: None,
        };

        let result = assembler.add_part(sms, "test_iccid".to_string());
        assert!(result.is_some());
        let msg = result.unwrap();
        assert_eq!(msg.content, "Hello");
        assert_eq!(msg.sms_indices.len(), 1);
    }

    #[test]
    fn test_two_part_message_in_order() {
        let mut assembler = SmsAssembler::new();
        let iccid = "test_iccid".to_string();

        // Part 1
        let sms1 = make_test_sms(1, 1, 2, 42, "Hello ");
        let result1 = assembler.add_part(sms1, iccid.clone());
        assert!(result1.is_none()); // Not complete yet

        // Part 2
        let sms2 = make_test_sms(2, 2, 2, 42, "World");
        let result2 = assembler.add_part(sms2, iccid);
        assert!(result2.is_some());

        let msg = result2.unwrap();
        assert_eq!(msg.content, "Hello World");
        assert_eq!(msg.sms_indices, vec![1, 2]);
    }

    #[test]
    fn test_two_part_message_out_of_order() {
        let mut assembler = SmsAssembler::new();
        let iccid = "test_iccid".to_string();

        // Part 2 arrives first
        let sms2 = make_test_sms(2, 2, 2, 42, "World");
        let result2 = assembler.add_part(sms2, iccid.clone());
        assert!(result2.is_none()); // Not complete yet

        // Part 1 arrives second
        let sms1 = make_test_sms(1, 1, 2, 42, "Hello ");
        let result1 = assembler.add_part(sms1, iccid);
        assert!(result1.is_some());

        let msg = result1.unwrap();
        assert_eq!(msg.content, "Hello World");
        assert_eq!(msg.sms_indices, vec![1, 2]);
    }

    #[test]
    fn test_duplicate_part_ignored() {
        let mut assembler = SmsAssembler::new();
        let iccid = "test_iccid".to_string();

        // Part 1
        let sms1 = make_test_sms(1, 1, 2, 42, "Hello");
        let result1 = assembler.add_part(sms1, iccid.clone());
        assert!(result1.is_none());

        // Part 1 again (duplicate)
        let sms1_dup = make_test_sms(1, 1, 2, 42, "Hello");
        let result_dup = assembler.add_part(sms1_dup, iccid.clone());
        assert!(result_dup.is_none());

        // Still waiting for part 2
        assert_eq!(assembler.pending_parts_count(), 1);
    }
}
