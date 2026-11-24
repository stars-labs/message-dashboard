//! Buffers multipart SMS parts until all arrive.

use crate::at_modem::AtSms;
use crate::identifiers::{Iccid, SmsAddress};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tracing::{debug, warn};

#[derive(Debug, Hash, Eq, PartialEq, Clone)]
struct MessageGroupKey {
    iccid: Iccid,
    sender: SmsAddress,
    ref_id: u8,
    total_parts: u8,
}

#[derive(Debug, Clone)]
struct MessagePart {
    part_number: u8,
    content: String,
    timestamp: String,
    index: u32,
    received_at: Instant,
}

#[derive(Debug, Clone)]
pub struct AssembledMessage {
    pub content: String,
    pub sender: SmsAddress,
    /// First part's timestamp.
    pub timestamp: String,
    /// SIM indices of every part, for deletion.
    pub sms_indices: Vec<u32>,
}

#[derive(Debug)]
pub struct SmsAssembler {
    buffer: HashMap<MessageGroupKey, Vec<MessagePart>>,
    timeout: Duration,
}

impl Default for SmsAssembler {
    fn default() -> Self {
        Self::new()
    }
}

impl SmsAssembler {
    pub fn new() -> Self {
        SmsAssembler {
            buffer: HashMap::new(),
            timeout: Duration::from_secs(300),
        }
    }

    /// Returns the message when all parts are present, or immediately for a single-part message.
    pub fn add_part(&mut self, sms: AtSms, iccid: &Iccid) -> Option<AssembledMessage> {
        let Some(concat_info) = &sms.concat_info else {
            return Some(AssembledMessage {
                content: sms.text,
                sender: sms.sender,
                timestamp: sms.timestamp,
                sms_indices: vec![sms.index],
            });
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

        let parts = self.buffer.entry(key.clone()).or_default();

        if parts.iter().any(|p| p.part_number == part.part_number) {
            warn!(
                "Duplicate part {} for ref_id={} - skipping",
                part.part_number, concat_info.ref_id
            );
            return None;
        }

        parts.push(part);

        if parts.len() == usize::from(concat_info.total_parts) {
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

    fn assemble_and_remove(&mut self, key: &MessageGroupKey) -> Option<AssembledMessage> {
        let parts = self.buffer.remove(key)?;

        let mut sorted_parts = parts;
        sorted_parts.sort_by_key(|p| p.part_number);

        let content = sorted_parts
            .iter()
            .map(|p| p.content.as_str())
            .collect::<Vec<_>>()
            .join("");

        let timestamp = sorted_parts.first()?.timestamp.clone();
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

    /// Drops groups older than the timeout and returns their parts as individual messages.
    pub fn cleanup_expired(&mut self) -> Vec<AssembledMessage> {
        let now = Instant::now();
        let mut expired = Vec::new();

        self.buffer.retain(|key, parts| {
            let Some(oldest) = parts.iter().map(|p| p.received_at).min() else {
                return false;
            };
            if now.duration_since(oldest) > self.timeout {
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
                false
            } else {
                true
            }
        });

        if !expired.is_empty() {
            debug!("Cleaned up {} expired message parts", expired.len());
        }

        expired
    }

    pub fn pending_count(&self) -> usize {
        self.buffer.len()
    }

    pub fn pending_parts_count(&self) -> usize {
        self.buffer.values().map(Vec::len).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::at_modem::{AtSms, ConcatInfo};
    use crate::types::SmsStorage;

    fn make_test_sms(index: u32, part_num: u8, total: u8, ref_id: u8, text: &str) -> AtSms {
        AtSms {
            storage: Some(SmsStorage::Me),
            index,
            part_indices: vec![index],
            sender: SmsAddress::from("+1234567890"),
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
            storage: Some(SmsStorage::Me),
            index: 1,
            part_indices: vec![1],
            sender: SmsAddress::from("+1234567890"),
            timestamp: "2024-01-01T00:00:00.000Z".to_string(),
            text: "Hello".to_string(),
            concat_info: None,
        };

        let result = assembler.add_part(sms, &Iccid::try_from("89860000000000000007").unwrap());
        assert!(result.is_some());
        let msg = result.unwrap();
        assert_eq!(msg.content, "Hello");
        assert_eq!(msg.sms_indices.len(), 1);
    }

    #[test]
    fn test_two_part_message_in_order() {
        let mut assembler = SmsAssembler::new();
        let iccid = Iccid::try_from("89860000000000000007").unwrap();

        let sms1 = make_test_sms(1, 1, 2, 42, "Hello ");
        let result1 = assembler.add_part(sms1, &iccid);
        assert!(result1.is_none());

        let sms2 = make_test_sms(2, 2, 2, 42, "World");
        let result2 = assembler.add_part(sms2, &iccid);
        assert!(result2.is_some());

        let msg = result2.unwrap();
        assert_eq!(msg.content, "Hello World");
        assert_eq!(msg.sms_indices, vec![1, 2]);
    }

    #[test]
    fn test_two_part_message_out_of_order() {
        let mut assembler = SmsAssembler::new();
        let iccid = Iccid::try_from("89860000000000000007").unwrap();

        let sms2 = make_test_sms(2, 2, 2, 42, "World");
        let result2 = assembler.add_part(sms2, &iccid);
        assert!(result2.is_none());

        let sms1 = make_test_sms(1, 1, 2, 42, "Hello ");
        let result1 = assembler.add_part(sms1, &iccid);
        assert!(result1.is_some());

        let msg = result1.unwrap();
        assert_eq!(msg.content, "Hello World");
        assert_eq!(msg.sms_indices, vec![1, 2]);
    }

    #[test]
    fn test_duplicate_part_ignored() {
        let mut assembler = SmsAssembler::new();
        let iccid = Iccid::try_from("89860000000000000007").unwrap();

        let sms1 = make_test_sms(1, 1, 2, 42, "Hello");
        let result1 = assembler.add_part(sms1, &iccid);
        assert!(result1.is_none());

        let sms1_dup = make_test_sms(1, 1, 2, 42, "Hello");
        let result_dup = assembler.add_part(sms1_dup, &iccid);
        assert!(result_dup.is_none());

        assert_eq!(assembler.pending_parts_count(), 1);
    }
}
