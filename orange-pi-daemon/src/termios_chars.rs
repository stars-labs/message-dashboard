use anyhow::{anyhow, Result};
use nix::sys::termios;

#[expect(
    clippy::as_conversions,
    reason = "nix declares SpecialCharacterIndices as a repr(usize) enum with no conversion to usize, and termios::control_chars is indexed by usize"
)]
fn control_char_slot(index: termios::SpecialCharacterIndices) -> usize {
    index as usize
}

pub fn set_control_char(
    term: &mut termios::Termios,
    index: termios::SpecialCharacterIndices,
    value: u8,
) -> Result<()> {
    let slot = term
        .control_chars
        .get_mut(control_char_slot(index))
        .ok_or_else(|| anyhow!("termios control character slot is out of range"))?;
    *slot = value;
    Ok(())
}
