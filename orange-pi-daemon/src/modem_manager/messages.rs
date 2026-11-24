use super::{BackendMode, ModemManager};
use crate::identifiers::{Iccid, SmsAddress};
use crate::message_store::{Segment, StoredSegment};
use crate::partial_sms;
use crate::types::{Message, MessageWithPath, SmsStorage};
use crate::wire::Direction;
use anyhow::{anyhow, Result};
use std::collections::HashMap;
use tracing::{debug, info, warn};

#[derive(Clone, Copy)]
struct MultipartGroup<'a> {
    iccid: &'a Iccid,
    modem_id: &'a str,
    sender: &'a SmsAddress,
    ref_id: u8,
    total_parts: u8,
}

impl ModemManager {
    /// Multipart messages are assembled across polling cycles from segments buffered in
    /// the message store.
    pub async fn get_new_messages_with_paths(
        &self,
        modem_id: &str,
        iccid: &Iccid,
        message_store: &crate::message_store::MessageStore,
    ) -> Result<Vec<MessageWithPath>> {
        match self.mode {
            BackendMode::AtCommand => self.get_at_messages(modem_id, iccid, message_store).await,
            BackendMode::DBus => self.get_dbus_messages(modem_id, iccid).await,
        }
    }

    async fn get_at_messages(
        &self,
        modem_id: &str,
        iccid: &Iccid,
        message_store: &crate::message_store::MessageStore,
    ) -> Result<Vec<MessageWithPath>> {
        let port = self.get_port(modem_id).await;
        let sms_list = self.at_modem.list_sms(&port).await?;

        let mut multipart_groups: HashMap<(SmsAddress, u8, u8), Vec<crate::at_modem::AtSms>> =
            HashMap::new();
        let mut complete_messages: Vec<MessageWithPath> = Vec::new();

        for sms in sms_list {
            if let Some(ref concat_info) = sms.concat_info {
                let key = (
                    sms.sender.clone(),
                    concat_info.ref_id,
                    concat_info.total_parts,
                );
                multipart_groups.entry(key).or_default().push(sms);
            } else {
                let Some(storage) = sms.storage else {
                    warn!("Skipping SMS {} without a recorded storage", sms.index);
                    continue;
                };
                complete_messages.push(MessageWithPath {
                    message: Message {
                        phone_iccid: iccid.clone(),
                        phone_number: sms.sender,
                        content: sms.text,
                        timestamp: sms.timestamp,
                        direction: Direction::Received,
                    },
                    modem_id: modem_id.to_string(),
                    sms_path: Self::format_at_sms_path(&[(storage, sms.index)]),
                });
            }
        }

        for ((sender, ref_id, total_parts), parts) in multipart_groups {
            let group = MultipartGroup {
                iccid,
                modem_id,
                sender: &sender,
                ref_id,
                total_parts,
            };
            complete_messages.extend(Self::assemble_multipart_group(
                message_store,
                &group,
                &parts,
            ));
        }

        debug!(
            "Got {} messages via AT from {} (after multipart assembly)",
            complete_messages.len(),
            modem_id
        );
        Ok(complete_messages)
    }

    /// Buffer the group's parts, then deliver the message once it is complete
    /// or its missing parts are not coming.
    fn assemble_multipart_group(
        message_store: &crate::message_store::MessageStore,
        group: &MultipartGroup<'_>,
        parts: &[crate::at_modem::AtSms],
    ) -> Option<MessageWithPath> {
        let MultipartGroup {
            iccid,
            sender,
            ref_id,
            total_parts,
            ..
        } = *group;

        for part in parts {
            let Some(concat_info) = part.concat_info.as_ref() else {
                warn!("Skipping segment without concatenation info");
                continue;
            };
            let Some(storage) = part.storage else {
                warn!("Skipping segment without a recorded storage");
                continue;
            };
            if let Err(e) = message_store.store_segment(&Segment {
                iccid,
                sender,
                ref_id,
                total_parts,
                part_number: concat_info.part_number,
                content: &part.text,
                timestamp: &part.timestamp,
                sms_storage: storage,
                sms_index: part.index,
            }) {
                warn!("Failed to store segment: {}", e);
            }
        }

        let message =
            match message_store.get_segments_with_storage(iccid, sender, ref_id, total_parts) {
                Ok(segments) if segments.len() == usize::from(total_parts) => {
                    Self::complete_message(group, segments)?
                }
                Ok(segments)
                    if partial_sms::is_orphaned(
                        &segments
                            .iter()
                            .map(|(_, _, timestamp, _, _)| timestamp.as_str())
                            .collect::<Vec<_>>(),
                        chrono::Utc::now(),
                    ) =>
                {
                    Self::orphaned_message(group, &segments)
                }
                Ok(segments) => {
                    debug!(
                        "Buffering multipart message: {}/{} parts for ref_id={} from {}",
                        segments.len(),
                        total_parts,
                        ref_id,
                        sender
                    );
                    return None;
                }
                Err(e) => {
                    warn!("Failed to check buffered segments: {}", e);
                    return None;
                }
            };

        if let Err(e) = message_store.delete_segments(iccid, ref_id) {
            warn!("Failed to delete segments: {}", e);
        }
        Some(message)
    }

    fn complete_message(
        group: &MultipartGroup<'_>,
        mut all_parts: Vec<StoredSegment>,
    ) -> Option<MessageWithPath> {
        all_parts.sort_by_key(|(part_num, _, _, _, _)| *part_num);

        let combined_text = all_parts
            .iter()
            .map(|(_, content, _, _, _)| content.as_str())
            .collect::<Vec<_>>()
            .join("");
        let timestamp = all_parts.first()?.2.clone();
        let all_locations: Vec<(SmsStorage, u32)> = all_parts
            .iter()
            .map(|(_, _, _, storage, index)| (*storage, *index))
            .collect();

        info!(
            "✅ Assembled multipart message: {} parts, {} chars, ref_id={} from {}",
            all_parts.len(),
            combined_text.len(),
            group.ref_id,
            group.sender
        );

        Some(MessageWithPath {
            message: Message {
                phone_iccid: group.iccid.clone(),
                phone_number: group.sender.clone(),
                content: combined_text,
                timestamp,
                direction: Direction::Received,
            },
            modem_id: group.modem_id.to_string(),
            sms_path: Self::format_at_sms_path(&all_locations),
        })
    }

    /// The missing parts are not coming. Deliver what did arrive, marked
    /// incomplete, so the usual store-then-delete path frees the SIM slots.
    fn orphaned_message(group: &MultipartGroup<'_>, segments: &[StoredSegment]) -> MessageWithPath {
        let numbered: Vec<(u8, String)> = segments
            .iter()
            .map(|(number, content, _, _, _)| (*number, content.clone()))
            .collect();
        let timestamp = segments
            .iter()
            .map(|(_, _, timestamp, _, _)| timestamp.clone())
            .min()
            .unwrap_or_default();
        let locations: Vec<(SmsStorage, u32)> = segments
            .iter()
            .map(|(_, _, _, storage, index)| (*storage, *index))
            .collect();

        info!(
            "📨 Delivering incomplete multipart message: {}/{} parts, ref_id={} from {}",
            segments.len(),
            group.total_parts,
            group.ref_id,
            group.sender
        );

        MessageWithPath {
            message: Message {
                phone_iccid: group.iccid.clone(),
                phone_number: group.sender.clone(),
                content: partial_sms::assemble_partial(group.total_parts, &numbered),
                timestamp,
                direction: Direction::Received,
            },
            modem_id: group.modem_id.to_string(),
            sms_path: Self::format_at_sms_path(&locations),
        }
    }

    async fn get_dbus_messages(
        &self,
        modem_id: &str,
        iccid: &Iccid,
    ) -> Result<Vec<MessageWithPath>> {
        let client = self
            .dbus_client
            .as_ref()
            .ok_or_else(|| anyhow!("D-Bus not initialized"))?;
        let native = client
            .native_client()
            .ok_or_else(|| anyhow!("Native D-Bus not available"))?;
        let sms_messages = native.list_sms(modem_id).await?;

        let messages: Vec<MessageWithPath> = sms_messages
            .into_iter()
            .map(|sms| MessageWithPath {
                message: Message {
                    phone_iccid: iccid.clone(),
                    phone_number: sms.number,
                    content: sms.text,
                    timestamp: Self::normalize_timestamp(&sms.timestamp),
                    direction: Direction::Received,
                },
                modem_id: modem_id.to_string(),
                sms_path: sms.path,
            })
            .collect();

        Ok(messages)
    }

    pub async fn get_new_messages(
        &self,
        modem_id: &str,
        iccid: &Iccid,
        message_store: &crate::message_store::MessageStore,
    ) -> Result<Vec<Message>> {
        let messages_with_paths = self
            .get_new_messages_with_paths(modem_id, iccid, message_store)
            .await?;
        Ok(messages_with_paths.into_iter().map(|m| m.message).collect())
    }
}
