//! Diagnostic-only timers. Nested spans overlap; no bytes or SQL parameters recorded.
use std::sync::{Mutex, atomic::{AtomicBool, Ordering}};
use std::time::Instant;
use serde_json::{Value,json};
static ACTIVE: AtomicBool = AtomicBool::new(false);
static ROWS: Mutex<Vec<Value>> = Mutex::new(Vec::new());
fn cpu_ns() -> u64 {
    let mut time: libc::timespec = unsafe { std::mem::zeroed() };
    assert_eq!(unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut time) },0);
    time.tv_sec as u64*1_000_000_000+time.tv_nsec as u64
}
pub fn reset() { ROWS.lock().unwrap().clear(); ACTIVE.store(true,Ordering::Relaxed); }
pub fn take() -> Value { ACTIVE.store(false,Ordering::Relaxed); json!(std::mem::take(&mut *ROWS.lock().unwrap())) }
pub struct Span { label:&'static str, start:Instant, cpu:u64, active:bool }
pub fn span(label:&'static str) -> Span { Span{label,start:Instant::now(),cpu:cpu_ns(),active:ACTIVE.load(Ordering::Relaxed)} }
impl Drop for Span {
 fn drop(&mut self) { if self.active { let ms=self.start.elapsed().as_secs_f64()*1000.;let cpu=(cpu_ns()-self.cpu) as f64/1_000_000.;ROWS.lock().unwrap().push(json!({"label":self.label,"ms":ms,"threadCpuMs":cpu})); } }
}
