---
title: "Custom PL: A Cache-Conscious C++ Compiler"
date: 2026-09-21 00:00:00 +0800
description: Building a small C++ compiler around precise diagnostics, checked constant evaluation, indexed AST nodes, C++17 code generation, and explicit region-based memory management.
permalink: /projects/custom-pl/
toc: true
comments: false
---

Custom PL is a compiler written in C++17 for a deliberately small integer language. The language supports immutable and mutable bindings, assignment, bounded `while` loops, arithmetic, comparisons, unary operators, and a final expression whose value becomes the program's output. The compiler validates the source as signed 64-bit constant computation and emits a standalone C++17 program.

The small language surface is intentional. It leaves enough room to work on the parts of compiler construction that become difficult at scale: source ownership, diagnostic locations, precedence and associativity, integer edge cases, AST layout, lifetime-aware allocation, and preserving semantics during code generation.

<div class="project-flow project-flow--four">
  <div><span>1</span><strong>Lex</strong><small>Convert source bytes into located tokens.</small></div>
  <div><span>2</span><strong>Parse</strong><small>Build a post-order, index-addressed AST.</small></div>
  <div><span>3</span><strong>Validate</strong><small>Evaluate with checked 64-bit semantics.</small></div>
  <div><span>4</span><strong>Generate</strong><small>Emit deterministic standalone C++17.</small></div>
</div>

## The language

A complete source file is a sequence of statements followed by one final expression:

```text
program      := statement* expression EOF
statement    := declaration | assignment | while_statement
declaration  := ("let" | "var") identifier "=" expression ";"
assignment   := identifier "=" expression ";"
while        := "while" "(" expression ")" "{" assignment* "}"
expression   := additive (comparison additive)?
additive     := term (("+" | "-") term)*
term         := unary (("*" | "/") unary)*
unary        := ("+" | "-")* primary
primary      := integer | identifier | "(" expression ")"
```

`let` creates an immutable binding and `var` creates a mutable one. A loop body contains assignments but not declarations or nested loops. Comparisons sit below arithmetic in the precedence hierarchy, return the integer `1` or `0`, and cannot be chained without parentheses.

```text
var width = 2;
width = width + 3;
width * -4 < -19
```

This program evaluates to `1`. The command-line compiler reads it from a file or standard input, writes generated C++ to standard output, and writes diagnostics to standard error in `file:line:column` form.

## Source-located lexing

The lexer is a single forward scan. Every token stores its byte offset, one-based line and one-based column, plus the token length. It recognises decimal integers, identifiers, the `let`, `var`, and `while` keywords, punctuation, arithmetic operators, and one- or two-byte comparison operators.

```cpp
struct SourceLocation {
    std::size_t offset;
    std::size_t line;
    std::size_t column;
};

struct Token {
    TokenKind kind;
    SourceLocation location;
    std::size_t length;
};
```

The offset is the canonical coordinate for slicing the original `std::string_view`; line and column are carried for human-readable diagnostics. Windows `CRLF` is consumed as one logical newline, while bare `CR` and `LF` are also accepted. Keyword recognition happens only after the complete identifier has been scanned, so `while_count` remains an identifier rather than being split at `while`.

Invalid input returns a diagnostic and discards the partial token stream. That is a useful phase boundary: the parser either receives a complete stream terminated by one explicit `end` token or it does not run.

{% raw %}
```cpp
default:
    return {{}, Diagnostic{
        start,
        "unexpected byte " + std::to_string(
            static_cast<unsigned char>(character))
    }};
```
{% endraw %}

Reporting the offending byte as an unsigned value matters because plain `char` may be signed. Otherwise, non-ASCII input can be promoted to a negative integer and produce a misleading diagnostic.

## Recursive descent with explicit precedence

The parser uses one function per precedence level. `expression` handles at most one comparison, `additive` folds `+` and `-`, `term` folds `*` and `/`, and `unary` wraps a primary in prefix operators. The loops in the additive and multiplicative levels make those operators left-associative.

```cpp
NodeIndex additive(std::size_t depth) {
    auto left = term(depth);
    while (left &&
        (current().kind == TokenKind::plus ||
         current().kind == TokenKind::minus)) {
        const Token operation = current();
        ++cursor_;
        const auto right = term(depth);
        if (!right) return std::nullopt;
        left = binary(operation, *left, *right);
    }
    return left;
}
```

Unary chains are parsed iteratively rather than recursively. The parser first consumes the complete prefix, parses one primary, then adds unary nodes from right to left. This preserves the grammar of `---value` without making a long sign sequence consume the C++ call stack.

Parenthesised expressions do recurse, so that path has a hard nesting limit of 256. The limit is not merely a user-interface choice: it turns stack consumption into an explicit language constraint instead of allowing adversarial input to exhaust the compiler process.

## Replacing an owning pointer tree

The first AST design was a conventional recursive graph. Each expression variant owned its children with `std::unique_ptr`:

```cpp
struct BinaryExpression {
    TokenKind operation;
    std::unique_ptr<Expression> left;
    std::unique_ptr<Expression> right;
};

using Expression = std::variant<
    IntegerExpression,
    IdentifierExpression,
    BinaryExpression,
    UnaryExpression
>;
```

This is safe and idiomatic, but it gives each node an independent allocation and destruction path even though almost every node has the same lifetime. A tree with `N` expressions approaches `N` node allocations, its edges are pointer-sized, and traversal follows addresses that may be scattered across the heap.

The compiler now stores expression variants in one array and represents edges as indices:

```cpp
struct BinaryExpression {
    TokenKind operation;
    std::size_t left;
    std::size_t right;
};

struct UnaryExpression {
    TokenKind operation;
    std::size_t operand;
};

struct ExpressionNode {
    SourceLocation location;
    std::variant<
        IntegerExpression,
        IdentifierExpression,
        BinaryExpression,
        UnaryExpression
    > value;
};

struct ParseResult {
    std::vector<ExpressionNode> nodes;
    std::vector<Statement> statements;
    std::optional<std::size_t> root;
    std::optional<Diagnostic> error;
};
```

The parser appends children before their parent. For example, `a + b` produces the identifier for `a`, the identifier for `b`, and then a binary node containing those two earlier indices. This establishes a post-order invariant:

```text
for every expression node i:
    every operand index of i is less than i
```

That invariant removes the need for recursive evaluation. A value array can be filled from index zero upward because every operand has already been evaluated when its parent is reached.

```cpp
const auto& binary = std::get<BinaryExpression>(node.value);
const Integer left = values[binary.left].number;
const Integer right = values[binary.right].number;
```

Indices survive `std::vector` relocation, can be range-checked, and can later be narrowed to a 32-bit `NodeId` if the compiler enforces a node-count bound. They also make serialization and debug output easier because a node retains a stable logical identity even when the backing array moves.

The layout is an **array of variants**, not a full structure-of-arrays representation. Every slot is large and aligned enough for the largest alternative. If one rare node type becomes much larger than the rest, separating node categories into their own arrays may reduce internal fragmentation. The current design is a useful middle ground: one identifier space, straightforward `std::visit` dispatch, and far fewer individual allocations without a type-segregated rewrite.

## Checked signed-integer semantics

The evaluator does not rely on signed overflow wrapping, because signed overflow is undefined in C++. Every arithmetic operation is checked before it executes.

Addition and subtraction use boundary comparisons:

```cpp
if ((right > 0 && left > maximum - right) ||
    (right < 0 && left < minimum - right)) {
    return Diagnostic{node.location, "integer overflow"};
}
result.number = left + right;
```

Multiplication is handled by sign quadrant. The implementation divides the appropriate bound by one operand before performing the multiplication, avoiding the overflowing operation it is trying to detect. Division separately rejects a zero divisor and the one overflowing signed division, `INT64_MIN / -1`.

### Representing `INT64_MIN`

The magnitude `9223372036854775808` is one larger than `INT64_MAX`, yet it must be accepted directly beneath unary minus so the language can represent `INT64_MIN`. The evaluator therefore parses literals as `std::uint64_t` magnitudes and records a special `minimum_magnitude` state. That state is legal only when the parser-built parent is an immediate unary minus.

```cpp
const std::uint64_t limit = negative_literal[index]
    ? minimum_magnitude
    : static_cast<std::uint64_t>(maximum);

for (char character : literal->digits) {
    const auto digit = static_cast<std::uint64_t>(character - '0');
    if (magnitude > (limit - digit) / 10) {
        return Diagnostic{node.location, "integer literal out of range"};
    }
    magnitude = magnitude * 10 + digit;
}
```

The pre-multiplication inequality detects decimal overflow without first overflowing `magnitude * 10 + digit`.

## Bindings, assignment, and bounded loops

The environment maps source names to a value and a mutability bit. An initializer is evaluated before its new binding is inserted, so a declaration cannot refer to itself. Redeclaration is rejected, assignment to a `let` binding is rejected, and an assignment updates its target only after the right-hand side completes successfully.

Loops require special care because the same AST nodes execute repeatedly. Before each condition test, the evaluator truncates the value table to the condition's first node and resets the next-node cursor. The condition and body are then recomputed against the current bindings.

```cpp
while (true) {
    values.resize(loop->condition_start);
    next_node = loop->condition_start;

    if (auto error = evaluate_through(loop->condition)) {
        return {std::nullopt, std::move(error)};
    }
    if (values[loop->condition].number == 0) break;
    if (completed == max_while_iterations) {
        return failure(loop->location,
            "while iteration limit exceeded");
    }

    // Evaluate assignments, then commit their values.
    ++completed;
}
```

The limit is 10,000 completed body executions; attempting to enter a 10,001st iteration is an error. Names and literal ranges inside the body are validated even if the loop never executes, while arithmetic errors occur only on an executed path. This distinction keeps generated programs structurally valid without inventing runtime failures for dead constant code.

## Deterministic C++17 generation

Code generation begins by evaluating the complete source program. That validation pass proves that the constant-only program has no source, binding, arithmetic, or loop-limit error. The generator then parses again and emits one temporary for each expression node.

Source-level names never appear directly in the generated C++. They are mapped to `binding_N`, which prevents collisions with C++ keywords and makes output deterministic. Comparisons are explicitly converted from C++ `bool` to the language's signed 64-bit `0` or `1`.

The earlier example becomes:

```cpp
#include <cstdint>
#include <iostream>

int main() {
    const std::int64_t v0 = 2LL;
    std::int64_t binding_0 = v0;
    const std::int64_t v1 = binding_0;
    const std::int64_t v2 = 3LL;
    const std::int64_t v3 = (v1 + v2);
    binding_0 = v3;
    const std::int64_t v4 = binding_0;
    const std::int64_t v5 = 4LL;
    const std::int64_t v6 = (-v5);
    const std::int64_t v7 = (v4 * v6);
    const std::int64_t v8 = 19LL;
    const std::int64_t v9 = (-v8);
    const std::int64_t v10 =
        static_cast<std::int64_t>(v7 < v9);
    std::cout << v10 << '\n';
    return 0;
}
```

Emitting temporaries rather than reconstructing a large nested expression has two advantages: source evaluation order remains explicit, and each generated value corresponds directly to an AST index. The minimum signed integer receives a special expression that constructs it without asking the C++ compiler to negate an unrepresentable positive `int64_t` value.

Validated constant `while` statements become `while (true)` blocks with an explicit condition check. This is safe for the current language because validation has already executed the same constant program within the iteration bound. Once runtime-dependent input is added, the generated program will need its own overflow and loop-limit checks rather than relying on compile-time evaluation.

## Matching allocation to compiler lifetimes

Dense node storage removes most per-node allocations, but compilers still create many variable-sized objects: token buffers, strings, statement lists, argument lists, symbols, and diagnostic data. Most of those objects live for a whole phase or compilation unit and then die together.

A general-purpose allocator supports arbitrary allocation sizes and destruction order. That flexibility carries bookkeeping, free-list work, fragmentation, and weaker locality. A compiler region has a simpler contract: allocate repeatedly, retain everything for the region's lifetime, then release all storage together.

The memory design uses a growing monotonic arena. The fast path aligns the current pointer, verifies that the request fits, returns that address, and advances the pointer. If the current block cannot satisfy the request, the arena links a new geometrically larger block without moving existing objects.

```cpp
void* allocate(std::size_t bytes, std::size_t alignment) {
    void* result = align(current, alignment);

    if (!fits(result, bytes, end)) {
        result = allocate_from_new_block(bytes, alignment);
    }

    current = advance(result, bytes);
    return result;
}
```

The production path must implement `align`, `fits`, and `advance` with integer-address arithmetic that checks overflow, honours over-alignment, and never performs out-of-bounds pointer arithmetic. The simplified version shows the invariant, not those safety details.

Individual deallocation is a no-op. When the arena is reset or destroyed, it walks the linked blocks and releases each one. Storage reclamation changes from one heap operation per object to roughly one operation per arena block. Objects with meaningful destructors still require destruction; the arena changes storage ownership, not C++ object semantics.

## Integrating the arena through `std::pmr`

The allocator implements `std::pmr::memory_resource`, allowing standard PMR containers to use it without putting the arena type into every container's static type.

```cpp
class ArenaResource final : public std::pmr::memory_resource {
private:
    void* do_allocate(
        std::size_t bytes,
        std::size_t alignment) override;

    void do_deallocate(
        void*, std::size_t, std::size_t) override {
        // Storage is reclaimed when the arena is reset.
    }

    bool do_is_equal(
        const std::pmr::memory_resource& other
    ) const noexcept override {
        return this == &other;
    }
};
```

`std::pmr::polymorphic_allocator` forwards both byte size and alignment to the resource. A stable container type can therefore switch between the arena, `new_delete_resource`, a tracking resource, or a deliberately failing test resource at runtime. The virtual call occurs when a container acquires or releases backing storage, not on element access.

```cpp
ArenaResource memory;
std::pmr::vector<ExpressionNode> nodes{&memory};
std::pmr::unordered_map<std::pmr::string, Symbol> symbols{&memory};
```

Allocator propagation is not automatic merely because an outer object lives in a PMR vector. Any nested PMR container must be allocator-aware or explicitly constructed with the intended resource; otherwise it silently uses the default resource and reintroduces general heap allocation.

The resource must also outlive every container that references it. Member declaration order can encode that invariant:

```cpp
class CompilationUnit {
    ArenaResource memory;
    Ast ast; // destroyed before memory
};
```

C++ destroys members in reverse declaration order, so `ast` releases its allocator-aware objects while `memory` is still alive.

## Arena and vector growth: a subtle interaction

When a vector grows, it allocates a larger buffer, moves its elements, and deallocates the old buffer. In a monotonic resource, that last operation does nothing. Every abandoned capacity remains occupied until the entire arena is reset.

```text
arena block
┌──────────────┬──────────────────┬────────────────────────┐
│ old capacity │ newer capacity   │ current live capacity  │
│ unreachable  │ unreachable      │ AST nodes              │
└──────────────┴──────────────────┴────────────────────────┘
```

This is not a leak beyond the region's lifetime, but it can increase peak memory. Reserving an estimated node count, using fixed-size pages, or adopting a segmented append-only table can avoid repeated abandoned buffers. The best choice depends on whether compact traversal, pointer stability, construction cost, or peak memory is the dominant constraint.

The arena and indexed AST solve different problems. The array removes most logical allocation requests and improves node density. The arena makes the remaining larger requests cheap and gives auxiliary storage the same bulk lifetime. An arena alone would not turn a pointer-heavy tree into a cache-friendly structure; data layout still matters.

## Validation and test strategy

<div class="project-metrics project-metrics--four">
  <div><strong>157</strong><small>CTest cases</small></div>
  <div><strong>28</strong><small>generated-program integration cases</small></div>
  <div><strong>256</strong><small>maximum parenthesis depth</small></div>
  <div><strong>10,000</strong><small>maximum loop-body executions</small></div>
</div>

The test suite covers the lexer, parser, evaluator, generator, and command-line interface independently. Boundary cases include CRLF handling, embedded nulls, invalid bytes, precedence, associativity, long unary and binary chains, nesting limits, source ownership, literal limits, every arithmetic overflow class, mutation rules, comparison semantics, loop validation, filesystem errors, and broken output streams.

The strongest check is the native code-generation integration test. It generates C++ for 28 programs, compiles those programs with the active C++ compiler, runs them, and compares their output with both explicit expectations and the interpreter. This differential check tests the semantic contract across two execution paths:

```text
Custom PL source ──▶ evaluator ─────────────────▶ int64 result
        │
        └──────────▶ C++ generator ▶ compiler ▶ executable output
                                      │
                                      └──── results must agree
```

All 157 tests pass on the verified Apple Clang 17 build. That result establishes correctness for the tested language subset; it is not a performance benchmark for the arena or indexed representation.

## Current boundaries

> **Custom PL is intentionally a constant-program compiler.** It emits real C++17, but it does not yet accept runtime input or expose a general runtime environment.
{: .prompt-info }

- Programs operate on signed 64-bit integers only.
- A file must end with one expression; there are no functions, user-defined types, or modules.
- Loop bodies contain assignments only, and nested loops are not part of the current grammar.
- Code generation validates by evaluating and then reparses the source; retaining a checked AST would remove duplicated frontend work.
- Generated arithmetic relies on prior constant validation. Runtime-dependent values will require emitted overflow and division checks.
- The array-of-variants layout can waste space when variant alternatives diverge significantly in size.
- Arena-backed vectors need capacity planning or segmented storage to control peak memory.
- The memory architecture needs measured allocation counts, peak-resident memory, and traversal benchmarks before making performance claims.

## What I would build next

1. Return a typed, checked intermediate representation from semantic analysis so evaluation and code generation share one validated program.
2. Introduce runtime inputs together with generated checked-arithmetic helpers and bounded-loop enforcement.
3. Replace raw `std::size_t` edges with strong `ExpressionId`, `StatementId`, and `BindingId` types plus debug-time bounds checks.
4. Propagate one PMR resource through every allocator-aware AST alternative and audit accidental fallback to the default resource.
5. Benchmark pointer-tree, indexed-vector, reserved-vector, and segmented-node-table layouts under identical source programs.
6. Measure total allocations, arena slack, abandoned vector capacity, peak resident memory, parse time, and traversal time separately.
7. Add functions and lexical scopes only after the ownership and symbol-lifetime rules are explicit.

## Takeaway

The most important part of Custom PL is not the size of its grammar. It is the decision to make invariants visible. Tokens own source locations. Precedence is encoded in parser structure. Every child index precedes its parent. Arithmetic is checked before execution. Loops have an explicit bound. Generated identifiers cannot collide with source names. AST storage has one clear owner, and the arena models the lifetime the compiler actually has.

The allocator and AST redesign are complementary: compact indices reduce the work requested from the allocator, while region-based storage makes the remaining work cheap to allocate and simple to reclaim. Together, they move the compiler away from a forest of unrelated heap objects and toward a representation shaped by the way compilation really proceeds.
