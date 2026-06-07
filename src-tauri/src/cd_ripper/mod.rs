pub mod encoder;
pub mod ripper;
pub mod toc;
#[cfg(windows)]
pub mod win_cd;

pub use ripper::rip_cd;
pub use toc::detect_disc;

// Re-export for tests; kept here so the symbol stays public.
#[allow(unused_imports)]
pub use crate::metadata::disc_id::calculate_musicbrainz_id;
