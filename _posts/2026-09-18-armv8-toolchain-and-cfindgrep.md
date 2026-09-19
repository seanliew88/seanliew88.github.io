---
title: ARMv8 Toolchain & CFindGrep
date: 2026-09-18 00:00:00 +0800
description: Building a two-pass ARMv8 assembler and emulator, then applying POSIX threads, condition variables, and recursive pattern matching to a concurrent find-and-grep tool.
permalink: /projects/cfindgrep/
toc: true
comments: false
---

This project began as a four-person systems assignment: build an assembler and emulator for a subset of ARMv8-A, use the toolchain to control a Raspberry Pi GPIO pin, then design an original C extension. Our extension was **CFindGrep**, a Unix-style command-line program that combines recursive filename discovery with content search and runs both stages concurrently.

The interesting thread connecting the two halves is systems-level reasoning. The assembler turns structured text into exact bit fields; the emulator reconstructs architectural state from those bits; and CFindGrep coordinates multiple threads without losing work, corrupting a queue, or interleaving output.

<div class="project-flow project-flow--four">
  <div><span>1</span><strong>Parse</strong><small>Convert assembly text into an instruction-level representation.</small></div>
  <div><span>2</span><strong>Encode</strong><small>Resolve symbols and emit 32-bit ARMv8 words.</small></div>
  <div><span>3</span><strong>Execute</strong><small>Decode instructions and mutate simulated CPU state.</small></div>
  <div><span>4</span><strong>Extend</strong><small>Apply concurrency primitives to filesystem search.</small></div>
</div>

## ARMv8 assembler

The assembler uses two passes because a branch can refer to a label that has not yet appeared. During the first pass, it walks every source line, advances the current address for each instruction or directive, and records each label in a symbol table. The second pass parses and encodes the actual instructions. By then, every label has a concrete address, so branch and literal-load offsets can be calculated relative to the program counter.

Rather than letting string parsing leak into every encoder, the parser produces an intermediate representation containing the mnemonic and typed operands. A central `EncodeMappingTable` selects an encoder for the instruction class. Each encoder then constructs the final word by masking and shifting fields such as `sf`, `opc`, register indices, immediates, and addressing-mode bits into their architectural positions.

This separation made the design easier to validate:

```text
source line → tokenizer/parser → typed instruction → class encoder → uint32_t
                                      ↑
                         symbol table resolves labels
```

The main correctness boundary is field width. An immediate that does not fit its signed or unsigned field must be rejected before it is shifted; otherwise, high bits can silently spill into an adjacent opcode field. PC-relative offsets also need alignment and range checks before they are converted from byte addresses into instruction units.

## Emulator and GPIO validation

The emulator models registers, memory, the program counter, and the processor flags needed by the supported instruction subset. Its fetch-decode-execute loop reads one 32-bit instruction, classifies it by its fixed opcode bits, extracts operands, applies the instruction semantics, and updates the program counter.

We then used the assembler output for a Raspberry Pi LED program. GPIO14 is configured through `GPFSEL1` at offset `0x4` from the GPIO base address `0x3f200000`: bits 12–14 are cleared with `BIC`, then set to `001` with `ORR` to select output mode. Writing `1 << 14` to `GPSET0` at offset `0x1c` turns the pin on; writing the same bit to `GPCLR0` at offset `0x28` turns it off.

The emulator's normal memory is only 2 MiB, so memory-mapped GPIO addresses cannot be treated as ordinary RAM. The load/store path detects accesses in the GPIO range and reports the simulated hardware write instead. That small adaptation let the same assembled program validate both the encoder and the observable I/O sequence without requiring physical hardware for every test.

## CFindGrep command model

CFindGrep exposes three operations:

| Mode | Purpose |
| --- | --- |
| `-f` | Recursively find filenames that match a glob-like pattern. |
| `-g` | Search the contents of the supplied files. |
| `-fg` | Discover matching files and stream them directly into the grep stage. |

The find stage can run serially with `-fs`, allocate one worker per supplied root with `-fm`, or use the `-fN` concurrent strategy. `-ftN` benchmarks all find modes, using `N` workers for the concurrent case. The grep stage supports line numbers (`-n`), case-insensitive matching (`-i`), match counts (`-c`), filenames only (`-l`), and a configurable worker count (`-t N`, defaulting to four).

```console
./findgrep -fg ./src ./doc "*.c" -- -i -n "todo"
```

The `--` delimiter is important: options before it configure filename discovery, while options after it configure content matching. Parsing the command once into a `Command` structure means worker threads consume validated state rather than repeatedly interpreting `argv`.

## Recursive filename matching

The filename matcher supports literal characters, `?`, `*`, sets such as `[abc]`, ranges such as `[a-z]`, and negated sets such as `[!abc]`. Its entry point is a recursive state machine over two pointers: one into the pattern and one into the filename.

```c
bool pattern_match(const char *pattern, const char *text) {
    if (*pattern == '\0') {
        return *text == '\0';
    }

    switch (*pattern) {
        case '*':
            return match_star(pattern, text);
        case '?':
            return match_question(pattern, text);
        case '[':
            return match_bracket(pattern, text);
        default:
            if (*text == '\0' || *pattern != *text) {
                return false;
            }
            return pattern_match(pattern + 1, text + 1);
    }
}
```

`*` is the only branch that must try more than one alignment. After skipping the star, it tests the remaining pattern at every suffix of the remaining text. The final call is necessary because `*` may also consume the entire string—or no characters at all.

```c
static bool match_star(const char *pattern, const char *text) {
    pattern++;

    while (*text != '\0') {
        if (pattern_match(pattern, text)) {
            return true;
        }
        text++;
    }

    return pattern_match(pattern, text);
}
```

This implementation is compact and correct for the supported grammar. Its trade-off is worst-case backtracking: patterns containing several stars can revisit the same `(pattern, text)` states. Memoising those pointer pairs, or compiling the pattern into an automaton, would bound repeated work for adversarial inputs.

## Find-side thread completion

In the concurrent find mode, directory traversal can discover more directories dynamically, so the main thread does not know every worker ID in advance. Workers are detached rather than collected with a fixed sequence of `pthread_join` calls. Completion is therefore expressed as shared state: `nactive` counts outstanding workers, a mutex protects the counter, and a condition variable wakes the main thread when the count reaches zero.

```c
typedef struct {
    Command *cmd;
    TaskQueue tq;
    int nactive;
    pthread_mutex_t mutex;
    pthread_cond_t cond;
} SharedArgs;

static void *run_thread(void *arg) {
    DirThreadArgs *args = arg;
    recursive_dir(args->cur_path, args->targs);

    pthread_mutex_lock(&args->targs->mutex);
    args->targs->nactive--;
    if (args->targs->nactive == 0) {
        pthread_cond_signal(&args->targs->cond);
    }
    pthread_mutex_unlock(&args->targs->mutex);

    free(args->cur_path);
    free(args);
    return NULL;
}
```

The main thread waits in a loop, not an `if`, because POSIX condition-variable waits may wake spuriously. `pthread_cond_wait` atomically releases the mutex while sleeping and reacquires it before returning, so the predicate is checked while holding the same lock that guards updates.

```c
pthread_mutex_lock(&args.mutex);
while (args.nactive > 0) {
    pthread_cond_wait(&args.cond, &args.mutex);
}
pthread_mutex_unlock(&args.mutex);
```

The key invariant is that every successful worker creation increments `nactive` before that worker can finish, and every worker decrements it exactly once. Without that ordering, the main thread could observe zero and close the pipeline while a newly created worker is still live.

## The producer-consumer pipeline

Combined `-fg` mode does not wait for discovery to finish before searching. Find workers are producers: every matching regular file is pushed into a linked-list `TaskQueue`. Grep workers are consumers: they pop paths and scan them immediately. This overlaps directory I/O with file I/O and avoids storing the entire result set before useful work begins.

![CFindGrep producer-consumer architecture and the condition-variable guarded queue.](/assets/img/cfindgrep/producer-consumer-pipeline.png){: width="1467" height="825" }
_The find stage produces paths while grep workers consume them. The queue's closed state distinguishes “temporarily empty” from “no more work will ever arrive.”_

The queue owns a mutex, an `n_empty` condition variable, and a `closed` flag. A consumer must handle two different empty states:

```c
char *tq_pop(TaskQueue tq) {
    pthread_mutex_lock(&tq->mutex);

    while (tq->size == 0 && !tq->closed) {
        pthread_cond_wait(&tq->n_empty, &tq->mutex);
    }

    if (tq->size == 0 && tq->closed) {
        pthread_mutex_unlock(&tq->mutex);
        return NULL;
    }

    Node *node = tq->head;
    tq->head = node->next;
    if (--tq->size == 0) {
        tq->tail = NULL;
    }

    char *path = node->path;
    free(node);
    pthread_mutex_unlock(&tq->mutex);
    return path;
}
```

When a producer pushes a path, it signals one waiting consumer. When all find workers complete, the producer side marks the queue closed and broadcasts to every consumer. A worker that wakes to an empty, closed queue returns `NULL` and terminates. This is the termination protocol that prevents both premature exits and consumers sleeping forever.

## Grep workers and output atomicity

For grep-only mode, the supplied paths are inserted into the queue before workers start. The requested worker count is capped by the number of queued files so the program does not create threads that cannot receive work. In combined mode, workers may initially sleep on an empty queue while find is still producing.

Each grep worker repeatedly pops a path and calls `findText`. File scanning itself is independent, but terminal output is shared state. A dedicated print mutex encloses the complete formatted result—not individual calls to `printf` or `strcat`—so lines from different files cannot be spliced together.

The scanner supports logical lines longer than its fixed `fgets` buffer. It retains partial segments and tracks whether the current logical line has already matched, preventing a long line from being double-counted when it spans several reads. Case-sensitive search uses `strstr`; case-insensitive search uses `strstrnocase`. The formatting layer then applies `-n`, `-c`, and `-l` without changing the matching algorithm.

## Measured behaviour

The supplied demonstration searches two project trees for every filename and compares the three internal find strategies with Linux `find`:

```console
./findgrep -ft20 ../../armv8_52 ../../armv8_testsuite "*"
```

<div class="project-metrics project-metrics--four">
  <div><strong>1313.059 ms</strong><small>single-thread mode</small></div>
  <div><strong>899.181 ms</strong><small>one thread per path</small></div>
  <div><strong>72.573 ms</strong><small>20-thread mode</small></div>
  <div><strong>1098.914 ms</strong><small>Linux find</small></div>
</div>

![Terminal benchmark comparing CFindGrep's single-thread, per-path, and 20-thread traversal modes with Linux find.](/assets/img/cfindgrep/find-benchmark.png){: width="1467" height="825" }
_The recorded demonstration run. The first run was discarded as a filesystem-cache warm-up._

The 20-thread result is roughly **18.1× faster than the project's serial traversal in this particular run**. It is not a general claim that CFindGrep outperforms `find`: the workload, machine, cache state, output volume, and timing methodology all affect the result, and the report describes manual benchmarking rather than a statistically repeated experiment.

## Testing strategy

The assembler was tested instruction-class by instruction-class against expected 32-bit binaries, followed by integration tests that assembled programs and executed them in the emulator. The GPIO program provided an additional end-to-end check: its encoded load/store operations had to produce the expected simulated peripheral writes without breaking ordinary memory access.

CFindGrep was exercised on both small, hand-checkable directory trees and the full project repository. Those tests covered mode parsing, recursive traversal, pattern forms, grep options, long lines, and concurrent execution. A stronger next step would turn these manual cases into a repeatable harness and run them under ThreadSanitizer and Valgrind/AddressSanitizer.

## Engineering trade-offs and next steps

- **Bound thread creation.** Dynamically creating one detached thread per discovered directory can oversubscribe the machine or exhaust thread resources. A fixed traversal pool with a work-stealing or blocking directory queue would make resource use predictable.
- **Define ownership explicitly.** Queue nodes and path strings cross thread boundaries. Documenting whether `tq_push` copies or takes ownership of a path would make cleanup paths auditable and reduce leak or double-free risk.
- **Avoid unbounded output assembly.** Repeated `strcat` calls need a proven capacity invariant. A length-tracked buffer or direct `fprintf` under the print mutex would be safer.
- **Memoise glob states.** Caching recursive pattern states would prevent exponential backtracking on patterns with repeated `*` segments.
- **Benchmark rigorously.** Repeat cold-cache and warm-cache trials, report medians and dispersion, hold output constant, and test scaling across worker counts instead of drawing conclusions from one run.
- **Test concurrency failure paths.** Inject allocation and `pthread_create` failures, close the queue early, and verify that every waiter terminates without leaked work.

## Takeaway

The ARMv8 toolchain made correctness concrete at the bit level: every parser decision eventually changes a specific instruction field or machine-state transition. CFindGrep extended that discipline to concurrency. Its core design is not simply “use more threads”; it is a set of explicit predicates and ownership boundaries—active workers reach zero, an empty queue is either open or closed, and shared output is emitted atomically. Those invariants are what make the parallel pipeline understandable and testable.
