//! Round-trip a `.docx` through docx-rs: `read_docx` → `build` → `pack`, writing
//! the re-serialized document to the output path. The TypeScript checker then
//! diffs the original vs round-tripped `word/document.xml` to measure how much
//! content docx-rs preserves through a parse → serialize cycle — an editor needs
//! that cycle to be lossless.

use std::env;
use std::fs::{self, File};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let input = args.first().expect("usage: docx-roundtrip <input> <output>");
    let output = args.get(1).expect("usage: docx-roundtrip <input> <output>");

    let bytes = fs::read(input).expect("read input");
    let docx = docx_rs::read_docx(&bytes).expect("read_docx failed");
    let file = File::create(output).expect("create output");
    docx.build().pack(file).expect("pack failed");
}
