//! Isolated hash experiment; never used by the SDK comparison or published results.
use sha2::{Digest, Sha256};
use std::{fs, time::Instant};
fn main() {
    let path = std::env::args().nth(1).expect("fixture path");
    let bytes = fs::read(path).unwrap();
    assert_eq!(bytes.len(), 500_000_000);
    let started = Instant::now();
    let digest = Sha256::digest(std::hint::black_box(&bytes));
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    let digest = format!("{digest:x}");
    assert_eq!(digest, "f8f21b7fff2ba4c46e755ac9e80e874c31a95e40b19ce21046bfa4ceac01db84");
    println!("{{\"accelerated\":{},\"ms\":{},\"sha256\":\"{}\"}}", cfg!(feature="accelerated"), elapsed, digest);
}
