mod duplicate_log {
    use crate::message_store::*;
    use crate::wire::Direction;

    #[test]
    fn logging_a_duplicate_with_multibyte_text_does_not_panic() {
        let store = MessageStore::new(":memory:").unwrap();
        let message = Message {
            phone_iccid: Iccid::try_from("89860000000000000001").unwrap(),
            phone_number: SmsAddress::from("10086"),
            content: "您的登录验证码五分钟内有效请勿泄露".to_string(),
            timestamp: "2024-01-01T12:00:00.000Z".to_string(),
            direction: Direction::Received,
        };
        let subscriber = tracing_subscriber::fmt()
            .with_max_level(tracing::Level::DEBUG)
            .with_test_writer()
            .finish();

        tracing::subscriber::with_default(subscriber, || {
            assert!(store.store_message(&message, "modem", "at:1").unwrap());
            assert!(!store.store_message(&message, "modem", "at:2").unwrap());
        });
    }
}

mod segment_write {
    use crate::message_store::*;

    fn changes(store: &MessageStore) -> i64 {
        let conn = store.conn.lock().unwrap();
        conn.query_row("SELECT total_changes()", [], |row| row.get(0))
            .unwrap()
    }

    /// The AUTOINCREMENT counter; `total_changes()` does not count writes to
    /// `sqlite_sequence`.
    fn sequence(store: &MessageStore) -> i64 {
        let conn = store.conn.lock().unwrap();
        conn.query_row(
            "SELECT seq FROM sqlite_sequence WHERE name = 'multipart_segments'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn store_part(store: &MessageStore, content: &str, index: u32) {
        store
            .store_segment(&Segment {
                iccid: &Iccid::try_from("89860000000000000001").unwrap(),
                sender: &SmsAddress::from("10010"),
                ref_id: 84,
                total_parts: 9,
                part_number: 1,
                content,
                timestamp: "2025-10-09T01:47:57.000Z",
                sms_storage: SmsStorage::Sm,
                sms_index: index,
            })
            .unwrap();
    }

    #[test]
    fn storing_an_unchanged_segment_again_writes_nothing() {
        let store = MessageStore::new(":memory:").unwrap();
        store_part(&store, "part one", 3);
        let (changes_after_first, sequence_after_first) = (changes(&store), sequence(&store));

        for _ in 0..50 {
            store_part(&store, "part one", 3);
        }

        assert_eq!(changes(&store), changes_after_first);
        assert_eq!(sequence(&store), sequence_after_first);
    }

    #[test]
    fn a_segment_that_really_changed_is_updated() {
        let store = MessageStore::new(":memory:").unwrap();
        store_part(&store, "part one", 3);
        let before = changes(&store);

        store_part(&store, "part one", 7);

        assert_eq!(changes(&store), before + 1);
        let segments = store
            .get_segments_with_storage(
                &Iccid::try_from("89860000000000000001").unwrap(),
                &SmsAddress::from("10010"),
                84,
                9,
            )
            .unwrap();
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0].4, 7);
    }
}

mod queue_monitoring {
    use crate::message_store::*;

    #[test]
    fn reports_pending_dead_letter_and_in_flight_messages_without_an_attempt_cap() {
        let store = MessageStore::new(":memory:").unwrap();
        {
            let conn = store.conn.lock().unwrap();
            for (index, (status, attempts)) in [
                ("pending", 0),
                ("pending", 8),
                ("dead_letter", 5),
                ("dead_letter", 8),
                ("in_flight", 1),
                ("uploaded", 1),
            ]
            .into_iter()
            .enumerate()
            {
                conn.execute(
                    "INSERT INTO messages (
                        phone_iccid, phone_number, content, timestamp, direction,
                        modem_id, sms_path, status, attempts
                     ) VALUES ('iccid', '10010', ?3, CURRENT_TIMESTAMP, 'received',
                               'modem', ?4, ?1, ?2)",
                    params![
                        status,
                        attempts,
                        format!("content-{index}"),
                        format!("path-{index}")
                    ],
                )
                .unwrap();
            }
        }

        let stats = store.get_queue_stats().unwrap();
        assert_eq!(stats.pending, 2);
        assert_eq!(stats.dead_letter, 2);
        assert_eq!(stats.in_flight, 1);
    }

    fn insert_pending(store: &MessageStore, created_at: &str, index: usize) {
        let conn = store.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO messages (
                phone_iccid, phone_number, content, timestamp, direction,
                modem_id, sms_path, status, created_at
             ) VALUES ('iccid', '10010', ?2, CURRENT_TIMESTAMP, 'received',
                       'modem', ?3, 'pending', datetime('now', ?1))",
            params![
                created_at,
                format!("content-{index}"),
                format!("path-{index}")
            ],
        )
        .unwrap();
    }

    #[test]
    fn a_row_whose_iccid_predates_validation_is_dead_lettered_not_blocking_the_claim() {
        let store = MessageStore::new(":memory:").unwrap();
        {
            let conn = store.conn.lock().unwrap();
            for (index, iccid) in ["iccid_001", "898600520121F0517883"]
                .into_iter()
                .enumerate()
            {
                conn.execute(
                    "INSERT INTO messages (
                        source_message_id, phone_iccid, phone_number, content, timestamp,
                        direction, modem_id, sms_path, status, created_at
                     ) VALUES (?5, ?1, '10010', ?2, CURRENT_TIMESTAMP, 'received',
                               'modem', ?3, 'pending', datetime('now', ?4))",
                    params![
                        iccid,
                        format!("content-{index}"),
                        format!("path-{index}"),
                        format!("-{} minutes", 10 - index),
                        format!("source-{index}")
                    ],
                )
                .unwrap();
            }
        }

        let claimed = store.claim_messages(10, 90).unwrap();

        assert_eq!(claimed.len(), 1);
        assert_eq!(
            claimed[0].message.phone_iccid.as_str(),
            "898600520121F0517883"
        );
        let stats = store.get_queue_stats().unwrap();
        assert_eq!((stats.dead_letter, stats.in_flight), (1, 1));
    }

    #[test]
    fn reports_the_age_of_the_oldest_unacknowledged_message() {
        let store = MessageStore::new(":memory:").unwrap();
        insert_pending(&store, "-2 hours", 0);
        insert_pending(&store, "-5 minutes", 1);

        let age = store
            .get_queue_stats()
            .unwrap()
            .oldest_unacknowledged_age_seconds;

        assert!(age.is_some_and(|seconds| (7190..=7210).contains(&seconds)));
    }

    #[test]
    fn a_message_stamped_in_the_future_has_waited_no_time() {
        let store = MessageStore::new(":memory:").unwrap();
        insert_pending(&store, "+1 hour", 0);

        let age = store
            .get_queue_stats()
            .unwrap()
            .oldest_unacknowledged_age_seconds;

        assert_eq!(age, Some(0));
    }
}

mod status {
    use crate::message_store::*;

    #[test]
    fn statuses_are_stored_as_the_queue_text() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute("CREATE TABLE t (status TEXT NOT NULL)", [])
            .unwrap();
        for (status, text) in [
            (MessageStatus::Pending, "pending"),
            (MessageStatus::InFlight, "in_flight"),
            (MessageStatus::Uploaded, "uploaded"),
            (MessageStatus::DeadLetter, "dead_letter"),
        ] {
            conn.execute("DELETE FROM t", []).unwrap();
            conn.execute("INSERT INTO t VALUES (?1)", [status]).unwrap();
            let stored: String = conn
                .query_row("SELECT status FROM t", [], |row| row.get(0))
                .unwrap();
            assert_eq!(stored, text);
            let read: MessageStatus = conn
                .query_row("SELECT status FROM t", [], |row| row.get(0))
                .unwrap();
            assert_eq!(read, status);
        }
    }

    #[test]
    fn unrecognised_stored_status_is_an_error_not_a_guess() {
        let conn = Connection::open_in_memory().unwrap();
        for text in ["uploading", "failed", ""] {
            let read: rusqlite::Result<MessageStatus> =
                conn.query_row("SELECT ?1", [text], |row| row.get(0));
            assert!(read.is_err(), "{text:?}");
        }
    }

    #[test]
    fn claimed_messages_are_in_flight_and_keep_their_direction() {
        let store = MessageStore::new(":memory:").unwrap();
        let message = Message {
            phone_iccid: Iccid::try_from("89860000000000000001").unwrap(),
            phone_number: SmsAddress::from("10010"),
            content: "content".to_string(),
            timestamp: "2026-01-01T00:00:00.000Z".to_string(),
            direction: crate::wire::Direction::Received,
        };
        assert!(store.store_message(&message, "1", "at:ME:1").unwrap());
        let claimed = store.claim_messages(10, 60).unwrap();
        assert_eq!(claimed.len(), 1);
        assert_eq!(
            claimed[0].message.direction,
            crate::wire::Direction::Received
        );
        let stored: String = store
            .conn()
            .query_row("SELECT status FROM messages", [], |row| row.get(0))
            .unwrap();
        assert_eq!(stored, "in_flight");
    }
}
