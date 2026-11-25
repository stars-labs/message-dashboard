use super::*;

#[test]
fn age_text_is_none_when_the_queue_is_empty() {
    assert_eq!(age_text(None), "none");
}

#[test]
fn age_text_appends_seconds() {
    assert_eq!(age_text(Some(42)), "42s");
}
