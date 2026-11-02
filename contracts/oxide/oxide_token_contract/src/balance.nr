use crate::asserted_note::AssertedNote;
use aztec::{
    context::UtilityContext,
    note::{HintedNote, note_viewer_options::NoteViewerOptions},
    protocol::{constants::MAX_NOTE_HASH_READ_REQUESTS_PER_CALL, traits::Packable},
    state_vars::PrivateSet,
};

/// Recursively sums the amounts of all AssertedNotes in `notes_set` starting at `offset`.
/// Pages through the set since a single `view_notes` call is capped at `MAX_NOTES_PER_PAGE`.
/// Mirrors `balance-set::BalanceSet::balance_of_with_offset`.
pub unconstrained fn balance_of_with_offset(notes_set: PrivateSet<AssertedNote, UtilityContext>, offset: u32) -> u128 {
    let options = NoteViewerOptions::<AssertedNote, <AssertedNote as Packable>::N>::new().set_offset(offset);
    let notes = notes_set.view_notes(options);
    let mut balance: u128 = 0;
    for i in 0..options.limit {
        if i < notes.len() {
            balance += notes.get_unchecked(i).amount;
        }
    }
    if notes.len() == options.limit {
        balance += balance_of_with_offset(notes_set, offset + options.limit);
    }
    balance
}

/// Drops notes once the running sum reaches `min_sum`. With amount-descending sort, selects the fewest, largest notes
/// covering `min_sum`.
///
/// Copy from uint-note (not usable direclty as the original doesn't work with generic Note):
/// https://github.com/AztecProtocol/aztec-packages/blob/v4.3.0/noir-projects/aztec-nr/balance-set/src/balance_set.nr#L106
pub fn preprocess_notes_min_sum(
    notes: [Option<HintedNote<AssertedNote>>; MAX_NOTE_HASH_READ_REQUESTS_PER_CALL],
    min_sum: u128,
) -> [Option<HintedNote<AssertedNote>>; MAX_NOTE_HASH_READ_REQUESTS_PER_CALL] {
    let mut selected = [Option::none(); MAX_NOTE_HASH_READ_REQUESTS_PER_CALL];
    let mut sum: u128 = 0;
    for i in 0..notes.len() {
        if notes[i].is_some() & (sum < min_sum) {
            let hinted_note = notes[i].unwrap_unchecked();
            selected[i] = Option::some(hinted_note);
            sum += hinted_note.note.amount;
        }
    }
    selected
}
