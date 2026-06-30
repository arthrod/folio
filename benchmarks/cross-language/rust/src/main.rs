//! Cross-language parse benchmark: docx-rs (Rust).
//!
//! Parses each fixture passed as an argument N times and prints, as JSON on
//! stdout, the median wall time per parse in milliseconds. Fixtures that the
//! crate cannot parse are reported on stderr and omitted. The TypeScript runner
//! spawns this and tabulates the numbers next to folio and python-docx.

use std::env;
use std::fs;
use std::time::Instant;

const ITERATIONS: u32 = 20;

fn median(mut xs: Vec<f64>) -> f64 {
    xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mid = xs.len() / 2;
    if xs.len() % 2 == 1 {
        xs[mid]
    } else {
        (xs[mid - 1] + xs[mid]) / 2.0
    }
}

fn main() {
    let paths: Vec<String> = env::args().skip(1).collect();
    let mut results: Vec<String> = Vec::new();

    for path in &paths {
        let bytes = match fs::read(path) {
            Ok(bytes) => bytes,
            Err(err) => {
                eprintln!("docx-rs: cannot read {path}: {err}");
                continue;
            }
        };

        // Confirm the crate parses this fixture before timing it.
        if docx_rs::read_docx(&bytes).is_err() {
            eprintln!("docx-rs: failed to parse {path}");
            continue;
        }

        let mut samples: Vec<f64> = Vec::with_capacity(ITERATIONS as usize);
        for _ in 0..ITERATIONS {
            let start = Instant::now();
            let _ = docx_rs::read_docx(&bytes);
            samples.push(start.elapsed().as_secs_f64() * 1000.0);
        }

        results.push(format!(
            "{{\"path\":{path:?},\"median_ms\":{}}}",
            median(samples)
        ));
    }

    println!("[{}]", results.join(","));
}
