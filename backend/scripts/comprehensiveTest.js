#!/usr/bin/env node
/**
 * Comprehensive correctness test for the AI Logic Diagram Generator backend.
 * Run: node scripts/comprehensiveTest.js
 */

'use strict';

const { parseLogicQuestion } = require('../services/logicParser');
const { analyzeQuestion }     = require('../services/aiService');
const { buildCircuitModel }   = require('../services/circuitModelService');
const { generateDiagramSvg }  = require('../services/circuitDiagramService');
const { generateTruthTable }  = require('../services/truthTableService');
const { evaluateExpression }  = require('../utils/booleanEvaluator');
const { parseVhdl }           = require('../services/vhdlParser');

// ── colour helpers ───────────────────────────────────────────────────────────
const GREEN  = (s) => `\x1b[32m${s}\x1b[0m`;
const RED    = (s) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const BOLD   = (s) => `\x1b[1m${s}\x1b[0m`;

// ── result accumulator ───────────────────────────────────────────────────────
const results = [];

function pass(name) {
  results.push({ name, ok: true });
  console.log(`  ${GREEN('PASS')} ${name}`);
}

function fail(name, reason) {
  results.push({ name, ok: false, reason });
  console.log(`  ${RED('FAIL')} ${name}`);
  console.log(`       Reason: ${reason}`);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Build the full pipeline result for a parsed circuit object.
 * Returns { parsed, model, svg, table } or throws.
 */
function pipeline(parsed) {
  const model = buildCircuitModel(parsed);
  const svg   = generateDiagramSvg(model);
  const table = generateTruthTable(parsed);
  return { parsed, model, svg, table };
}

/**
 * Verify structural integrity of a circuit model.
 * Returns an array of error strings (empty → OK).
 */
function checkModelIntegrity(model) {
  const errors = [];

  // Collect all valid IDs: inputs + gate ids
  const allIds = new Set([
    ...(model.inputs || []),
    ...(model.gates || []).map((g) => g.id)
  ]);

  // Check every wire end exists in allIds
  (model.wires || []).forEach((wire, i) => {
    if (!allIds.has(wire.from)) {
      errors.push(`wire[${i}] .from="${wire.from}" is not a valid id`);
    }
    if (!allIds.has(wire.to)) {
      errors.push(`wire[${i}] .to="${wire.to}" is not a valid id`);
    }
  });

  // Check for duplicate gate ids
  const seen = new Set();
  (model.gates || []).forEach((g) => {
    if (seen.has(g.id)) errors.push(`Duplicate gate id "${g.id}"`);
    seen.add(g.id);
  });

  return errors;
}

/**
 * Verify that truth table rows match evaluateExpression for every combination.
 * Only runs when input count <= 8.
 */
function checkTruthTable(parsed, table) {
  if ((parsed.inputs || []).length > 8) return []; // skip large tables
  const errors = [];

  table.forEach((row, rowIdx) => {
    const values = {};
    (parsed.inputs || []).forEach((inp) => { values[inp] = row[inp]; });

    (parsed.outputs || []).forEach((out) => {
      const expected = evaluateExpression(parsed.expressions[out], values);
      const actual   = row[out];
      if (expected !== actual) {
        const combo = Object.entries(values).map(([k, v]) => `${k}=${v}`).join(',');
        errors.push(`Output ${out} mismatch at row ${rowIdx} (${combo}): table=${actual}, eval=${expected}`);
      }
    });
  });

  return errors;
}

/** Check SVG is non-empty and contains the <svg tag. */
function checkSvg(svg) {
  if (typeof svg !== 'string' || svg.length === 0) return 'SVG is empty or not a string';
  if (!svg.includes('<svg')) return 'SVG does not contain <svg element';
  return null;
}

/** Run all checks on a pipeline result and report pass/fail. */
function runChecks(testName, parsed, model, svg, table, extraChecks) {
  const integrityErrors = checkModelIntegrity(model);
  const ttErrors        = checkTruthTable(parsed, table);
  const svgError        = checkSvg(svg);

  const allErrors = [...integrityErrors, ...ttErrors];
  if (svgError) allErrors.push(svgError);
  if (extraChecks) {
    const extra = extraChecks(parsed, model, svg, table);
    if (extra) allErrors.push(...(Array.isArray(extra) ? extra : [extra]));
  }

  if (allErrors.length === 0) {
    pass(testName);
  } else {
    fail(testName, allErrors.join(' | '));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 1 – SOP / POS Boolean Expressions
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n' + BOLD('Category 1: SOP/POS Boolean Expressions'));

try {
  const parsed = parseLogicQuestion("F = A'B' + B'C'");
  const { model, svg, table } = pipeline(parsed);
  runChecks("SOP: F = A'B' + B'C'", parsed, model, svg, table);
} catch (e) { fail("SOP: F = A'B' + B'C'", `Exception: ${e.message}`); }

try {
  const parsed = parseLogicQuestion("F = AB + BC + CA");
  const { model, svg, table } = pipeline(parsed);
  runChecks("SOP: F = AB + BC + CA (majority)", parsed, model, svg, table);
} catch (e) { fail("SOP: F = AB + BC + CA (majority)", `Exception: ${e.message}`); }

try {
  // POS expression using AND of OR terms: F = (A+B')(A'+C)
  const parsed = parseLogicQuestion("F = (A+B')(A'+C)");
  const { model, svg, table } = pipeline(parsed);
  runChecks("POS: F = (A+B')(A'+C)", parsed, model, svg, table);
} catch (e) { fail("POS: F = (A+B')(A'+C)", `Exception: ${e.message}`); }

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 2 – Minterm lists
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n' + BOLD('Category 2: Minterm Lists'));

// Minterm expansion helper: expands Σm(...) into SOP form
function expandMinterms(inputNames, minterms) {
  if (!minterms.length) return '0';
  const n = inputNames.length;
  return minterms.map((m) => {
    const bits = [];
    for (let i = n - 1; i >= 0; i--) {
      bits.unshift((m >> i) & 1);
    }
    return inputNames.map((name, i) => bits[i] === 1 ? name : `NOT ${name}`).join(' AND ');
  }).join(' OR ');
}

try {
  // F = Σm(0,1,2,4) with 3 variables A,B,C
  const inputNames = ['A','B','C'];
  const minterms   = [0, 1, 2, 4];
  const expr = expandMinterms(inputNames, minterms);
  const parsed = {
    type: 'combinational', subtype: 'general',
    inputs: inputNames, outputs: ['F'],
    expressions: { F: expr },
    flipFlops: [], stateVariables: [],
    explanation: 'F = Σm(0,1,2,4)'
  };
  const { model, svg, table } = pipeline(parsed);

  // Verify each minterm row gives F=1 and all others F=0
  const mintermSet = new Set(minterms);
  const tableErrors = [];
  table.forEach((row, i) => {
    const expected = mintermSet.has(i) ? 1 : 0;
    if (row.F !== expected) tableErrors.push(`row ${i}: expected F=${expected}, got ${row.F}`);
  });

  runChecks('Minterm: F = Σm(0,1,2,4)', parsed, model, svg, table, () => tableErrors);
} catch (e) { fail('Minterm: F = Σm(0,1,2,4)', `Exception: ${e.message}`); }

try {
  // F = Σm(3,5,6,7) — 3 vars
  const inputNames = ['A','B','C'];
  const minterms   = [3, 5, 6, 7];
  const expr = expandMinterms(inputNames, minterms);
  const parsed = {
    type: 'combinational', subtype: 'general',
    inputs: inputNames, outputs: ['F'],
    expressions: { F: expr },
    flipFlops: [], stateVariables: [],
    explanation: 'F = Σm(3,5,6,7)'
  };
  const { model, svg, table } = pipeline(parsed);
  const mintermSet = new Set(minterms);
  const tableErrors = [];
  table.forEach((row, i) => {
    const expected = mintermSet.has(i) ? 1 : 0;
    if (row.F !== expected) tableErrors.push(`row ${i}: expected F=${expected}, got ${row.F}`);
  });
  runChecks('Minterm: F = Σm(3,5,6,7)', parsed, model, svg, table, () => tableErrors);
} catch (e) { fail('Minterm: F = Σm(3,5,6,7)', `Exception: ${e.message}`); }

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 3 – Multi-output combinational (full adder style)
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n' + BOLD('Category 3: Multi-output Combinational'));

try {
  const parsed = parseLogicQuestion(
    "Sum = A XOR B XOR Cin\nCout = AB + ACin + BCin"
  );
  const { model, svg, table } = pipeline(parsed);

  // Verify full-adder truth table manually
  const ttErrors = [];
  table.forEach((row) => {
    const { A, B, Cin, Sum, Cout } = row;
    const total = A + B + Cin;
    const expSum  = total % 2;
    const expCout = total >= 2 ? 1 : 0;
    if (Sum  !== expSum)  ttErrors.push(`Sum  mismatch: A=${A},B=${B},Cin=${Cin} => got ${Sum},  want ${expSum}`);
    if (Cout !== expCout) ttErrors.push(`Cout mismatch: A=${A},B=${B},Cin=${Cin} => got ${Cout}, want ${expCout}`);
  });

  runChecks('Multi-output: Full adder (Sum, Cout)', parsed, model, svg, table, () => ttErrors);
} catch (e) { fail('Multi-output: Full adder (Sum, Cout)', `Exception: ${e.message}`); }

try {
  // Multi-output with three separate one-bit outputs
  const parsed = parseLogicQuestion(
    "P = AB\nQ = A XOR B\nR = NOT A AND NOT B"
  );
  const { model, svg, table } = pipeline(parsed);
  runChecks('Multi-output: P=AB, Q=A XOR B, R=NOT A AND NOT B', parsed, model, svg, table);
} catch (e) { fail('Multi-output: P=AB, Q=A XOR B, R=NOT A AND NOT B', `Exception: ${e.message}`); }

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY 4 – Named circuits via analyzeQuestion
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n' + BOLD('Category 4: Named Circuits via analyzeQuestion'));

const namedCircuits = [
  {
    label: 'Named: half adder',
    question: 'Create a half adder',
    checks: (parsed, model) => {
      const errors = [];
      if (!parsed.outputs.includes('Sum'))   errors.push('Missing Sum output');
      if (!parsed.outputs.includes('Carry')) errors.push('Missing Carry output');
      // Verify Sum=XOR, Carry=AND
      const vals = [{A:0,B:0},{A:0,B:1},{A:1,B:0},{A:1,B:1}];
      vals.forEach(({A,B}) => {
        const expSum   = A ^ B;
        const expCarry = A & B;
        const gotSum   = evaluateExpression(parsed.expressions['Sum'],   {A,B});
        const gotCarry = evaluateExpression(parsed.expressions['Carry'], {A,B});
        if (gotSum   !== expSum)   errors.push(`Sum  mismatch A=${A},B=${B}: got ${gotSum},  want ${expSum}`);
        if (gotCarry !== expCarry) errors.push(`Carry mismatch A=${A},B=${B}: got ${gotCarry}, want ${expCarry}`);
      });
      return errors;
    }
  },
  {
    label: 'Named: full adder',
    question: 'Create a full adder',
    checks: (parsed) => {
      const errors = [];
      if (!parsed.outputs.includes('Sum'))  errors.push('Missing Sum output');
      if (!parsed.outputs.includes('Cout')) errors.push('Missing Cout output');
      return errors;
    }
  },
  {
    label: 'Named: 2-to-4 decoder',
    question: 'Design a 2-to-4 decoder',
    checks: (parsed) => {
      const errors = [];
      ['D0','D1','D2','D3'].forEach((d) => {
        if (!parsed.outputs.includes(d)) errors.push(`Missing output ${d}`);
      });
      // Only one output should be 1 for each input combination
      const combos = [{A:0,B:0},{A:0,B:1},{A:1,B:0},{A:1,B:1}];
      combos.forEach(({A,B}) => {
        const active = ['D0','D1','D2','D3'].filter(
          (d) => parsed.expressions[d] && evaluateExpression(parsed.expressions[d], {A,B}) === 1
        );
        if (active.length !== 1) errors.push(`At A=${A},B=${B}: ${active.length} outputs active (want 1)`);
      });
      return errors;
    }
  },
  {
    label: 'Named: 3-input majority gate',
    question: 'Build a 3-input majority gate',
    checks: (parsed) => {
      const errors = [];
      const out = parsed.outputs[0];
      if (!out) return ['No output defined'];
      const combos = [
        {A:0,B:0,C:0},{A:0,B:0,C:1},{A:0,B:1,C:0},{A:0,B:1,C:1},
        {A:1,B:0,C:0},{A:1,B:0,C:1},{A:1,B:1,C:0},{A:1,B:1,C:1}
      ];
      combos.forEach(({A,B,C}) => {
        const expected = (A+B+C) >= 2 ? 1 : 0;
        const got = evaluateExpression(parsed.expressions[out], {A,B,C});
        if (got !== expected) errors.push(`Majority mismatch A=${A},B=${B},C=${C}: got ${got}, want ${expected}`);
      });
      return errors;
    }
  },
  {
    label: 'Named: XNOR gate',
    question: 'Create an XNOR gate',
    checks: (parsed) => {
      const errors = [];
      const out = parsed.outputs[0];
      if (!out) return ['No output defined'];
      // Use actual inputs from parsed rather than assuming A,B
      const inputs = parsed.inputs;
      if (inputs.length < 2) return [`Expected >=2 inputs, got ${inputs.length}`];
      const [I0, I1] = inputs;
      const vals = [{[I0]:0,[I1]:0},{[I0]:0,[I1]:1},{[I0]:1,[I1]:0},{[I0]:1,[I1]:1}];
      const expected = [1, 0, 0, 1];
      vals.forEach((v, i) => {
        const got = evaluateExpression(parsed.expressions[out], v);
        if (got !== expected[i]) errors.push(`XNOR mismatch ${JSON.stringify(v)}: got ${got}, want ${expected[i]}`);
      });
      return errors;
    }
  },
  {
    label: 'Named: 2:1 mux',
    question: 'Design a 2:1 multiplexer',
    checks: (parsed) => {
      const errors = [];
      const out = parsed.outputs[0];
      if (!out) return ['No output defined'];
      // Inputs should include a select line
      const inputs = parsed.inputs;
      if (inputs.length < 3) return [`Expected >=3 inputs (2 data + 1 select), got ${inputs.length}`];
      return errors;
    }
  }
];

// analyzeQuestion is async; we collect promises and run them all
(async () => {
  for (const tc of namedCircuits) {
    try {
      const parsed = await analyzeQuestion(tc.question);
      const { model, svg, table } = pipeline(parsed);
      runChecks(tc.label, parsed, model, svg, table, tc.checks ? tc.checks : undefined);
    } catch (e) {
      fail(tc.label, `Exception: ${e.message}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // CATEGORY 5 – Sequential state equations
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n' + BOLD('Category 5: Sequential State Equations'));

  const seqTests = [
    {
      label: 'Sequential: D1=Q1\'Q0 + XQ1, D0=X\'Q0\' + Q1Q0, Z=Q1Q0',
      question: "D1 = Q1'Q0 + XQ1\nD0 = X'Q0' + Q1Q0\nZ = Q1Q0",
      checks: (parsed, model) => {
        const errors = [];
        if (parsed.type !== 'sequential') errors.push(`Expected type=sequential, got ${parsed.type}`);
        // CLK must be present
        if (!model.inputs.includes('CLK')) errors.push('CLK not in model.inputs');
        // DFF gates must exist for D1 and D0
        const dffIds = model.gates.filter((g) => g.type === 'D_FLIP_FLOP').map((g) => g.id);
        if (!dffIds.includes('dff_D1')) errors.push('Missing dff_D1 gate');
        if (!dffIds.includes('dff_D0')) errors.push('Missing dff_D0 gate');
        // DFF wires: check CLK and D-input wires reach valid sources
        const allIds = new Set([...model.inputs, ...model.gates.map((g) => g.id)]);
        model.wires
          .filter((w) => w.to === 'dff_D1' || w.to === 'dff_D0')
          .forEach((w) => {
            if (!allIds.has(w.from)) errors.push(`DFF wire from="${w.from}" is not a valid id`);
          });
        return errors;
      }
    },
    {
      label: 'Sequential: 2-bit up counter D0=NOT Q0, D1=Q1 XOR Q0',
      question: "D0 = NOT Q0\nD1 = Q1 XOR Q0",
      checks: (parsed, model) => {
        const errors = [];
        if (parsed.type !== 'sequential') errors.push(`Expected type=sequential, got ${parsed.type}`);
        if (!model.inputs.includes('CLK')) errors.push('CLK not in model.inputs');
        const dffGates = model.gates.filter((g) => g.type === 'D_FLIP_FLOP');
        if (dffGates.length < 2) errors.push(`Expected >=2 DFF gates, got ${dffGates.length}`);
        return errors;
      }
    }
  ];

  for (const tc of seqTests) {
    try {
      const parsed = parseLogicQuestion(tc.question);
      const { model, svg, table } = pipeline(parsed);
      runChecks(tc.label, parsed, model, svg, table, tc.checks);
    } catch (e) {
      fail(tc.label, `Exception: ${e.message}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // CATEGORY 6 – VHDL source input
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n' + BOLD('Category 6: VHDL Source Input'));

  const halfAdderVhdl = `
entity half_adder is
  port (
    a, b : in  std_logic;
    sum  : out std_logic;
    cout : out std_logic
  );
end half_adder;

architecture rtl of half_adder is
begin
  sum  <= a xor b;
  cout <= a and b;
end rtl;
`;

  try {
    const parsed = parseVhdl(halfAdderVhdl);
    const { model, svg, table } = pipeline(parsed);
    runChecks('VHDL: half adder', parsed, model, svg, table, (p) => {
      const errors = [];
      // sum should be XOR, cout should be AND
      const combos = [{a:0,b:0},{a:0,b:1},{a:1,b:0},{a:1,b:1}];
      // find canonical names
      const sumOut  = p.outputs.find((o) => /sum/i.test(o));
      const coutOut = p.outputs.find((o) => /cout|carry/i.test(o));
      if (!sumOut)  errors.push('No sum-like output found');
      if (!coutOut) errors.push('No cout/carry-like output found');
      if (sumOut && coutOut) {
        combos.forEach(({a,b}) => {
          const vals = {[p.inputs[0]]: a, [p.inputs[1]]: b};
          const gotSum  = evaluateExpression(p.expressions[sumOut],  vals);
          const gotCout = evaluateExpression(p.expressions[coutOut], vals);
          if (gotSum  !== (a^b))   errors.push(`VHDL sum mismatch a=${a},b=${b}`);
          if (gotCout !== (a&b))   errors.push(`VHDL cout mismatch a=${a},b=${b}`);
        });
      }
      return errors;
    });
  } catch (e) { fail('VHDL: half adder', `Exception: ${e.message}`); }

  const orGateVhdl = `
entity or_gate is
  port (
    x, y, z : in  std_logic;
    f        : out std_logic
  );
end or_gate;

architecture rtl of or_gate is
begin
  f <= x or y or z;
end rtl;
`;

  try {
    const parsed = parseVhdl(orGateVhdl);
    const { model, svg, table } = pipeline(parsed);
    runChecks('VHDL: 3-input OR gate', parsed, model, svg, table, (p) => {
      const errors = [];
      const out = p.outputs[0];
      if (!out) return ['No output'];
      const ins = p.inputs;
      // All zeros → 0; any 1 → 1
      const allZeroVals = {};
      ins.forEach((n) => { allZeroVals[n] = 0; });
      if (evaluateExpression(p.expressions[out], allZeroVals) !== 0)
        errors.push('OR gate should output 0 for all-zero inputs');
      const oneOneVals = {};
      ins.forEach((n) => { oneOneVals[n] = 0; });
      oneOneVals[ins[0]] = 1;
      if (evaluateExpression(p.expressions[out], oneOneVals) !== 1)
        errors.push('OR gate should output 1 when first input is 1');
      return errors;
    });
  } catch (e) { fail('VHDL: 3-input OR gate', `Exception: ${e.message}`); }

  // ═════════════════════════════════════════════════════════════════════════
  // CATEGORY 7 – Edge Cases
  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n' + BOLD('Category 7: Edge Cases'));

  // Single input
  try {
    const parsed = parseLogicQuestion("F = A");
    const { model, svg, table } = pipeline(parsed);
    runChecks('Edge: single input F=A', parsed, model, svg, table, (p) => {
      const errors = [];
      if (evaluateExpression(p.expressions['F'], {A:0}) !== 0) errors.push('F=A: F(0) should be 0');
      if (evaluateExpression(p.expressions['F'], {A:1}) !== 1) errors.push('F=A: F(1) should be 1');
      return errors;
    });
  } catch (e) { fail('Edge: single input F=A', `Exception: ${e.message}`); }

  // Constant 1
  try {
    const parsed = {
      type: 'combinational', subtype: 'general',
      inputs: [], outputs: ['F'],
      expressions: { F: '1' },
      flipFlops: [], stateVariables: [],
      explanation: 'Constant 1'
    };
    const { model, svg, table } = pipeline(parsed);
    runChecks('Edge: constant F=1', parsed, model, svg, table, (p) => {
      if (evaluateExpression(p.expressions['F'], {}) !== 1) return ['F=1 should always evaluate to 1'];
      return [];
    });
  } catch (e) { fail('Edge: constant F=1', `Exception: ${e.message}`); }

  // Constant 0
  try {
    const parsed = {
      type: 'combinational', subtype: 'general',
      inputs: [], outputs: ['F'],
      expressions: { F: '0' },
      flipFlops: [], stateVariables: [],
      explanation: 'Constant 0'
    };
    const { model, svg, table } = pipeline(parsed);
    runChecks('Edge: constant F=0', parsed, model, svg, table, (p) => {
      if (evaluateExpression(p.expressions['F'], {}) !== 0) return ['F=0 should always evaluate to 0'];
      return [];
    });
  } catch (e) { fail('Edge: constant F=0', `Exception: ${e.message}`); }

  // NOT only
  try {
    const parsed = parseLogicQuestion("F = A'");
    const { model, svg, table } = pipeline(parsed);
    runChecks("Edge: NOT only F=A'", parsed, model, svg, table, (p) => {
      const errors = [];
      if (evaluateExpression(p.expressions['F'], {A:0}) !== 1) errors.push("F=A': F(0) should be 1");
      if (evaluateExpression(p.expressions['F'], {A:1}) !== 0) errors.push("F=A': F(1) should be 0");
      return errors;
    });
  } catch (e) { fail("Edge: NOT only F=A'", `Exception: ${e.message}`); }

  // XOR chain
  try {
    const parsed = parseLogicQuestion("F = A XOR B XOR C XOR D");
    const { model, svg, table } = pipeline(parsed);
    runChecks('Edge: XOR chain A XOR B XOR C XOR D', parsed, model, svg, table, (p) => {
      const errors = [];
      // F should equal parity of inputs
      for (let i = 0; i < 16; i++) {
        const A = (i>>3)&1, B = (i>>2)&1, C = (i>>1)&1, D = i&1;
        const expected = (A^B^C^D);
        const got = evaluateExpression(p.expressions['F'], {A,B,C,D});
        if (got !== expected) errors.push(`XOR parity mismatch i=${i}: got ${got}, want ${expected}`);
      }
      return errors;
    });
  } catch (e) { fail('Edge: XOR chain A XOR B XOR C XOR D', `Exception: ${e.message}`); }

  // Double negation
  try {
    const parsed = parseLogicQuestion("F = A''");
    const { model, svg, table } = pipeline(parsed);
    runChecks("Edge: double negation F=A''", parsed, model, svg, table, (p) => {
      const errors = [];
      if (evaluateExpression(p.expressions['F'], {A:0}) !== 0) errors.push("F=A'': F(0) should be 0");
      if (evaluateExpression(p.expressions['F'], {A:1}) !== 1) errors.push("F=A'': F(1) should be 1");
      return errors;
    });
  } catch (e) {
    // Double negation may not be supported — mark as informational rather than failing
    fail("Edge: double negation F=A''", `Exception: ${e.message}`);
  }

  // ── Gate cache: no duplicate IDs ────────────────────────────────────────
  console.log('\n' + BOLD('Gate Cache: Duplicate ID Check'));

  try {
    // Expression with heavily shared subexpressions
    const parsed = parseLogicQuestion("F = A'B' + A'B + AB' + AB");
    const { model } = pipeline(parsed);
    const ids   = model.gates.map((g) => g.id);
    const uniq  = new Set(ids);
    if (ids.length !== uniq.size) {
      const dups = ids.filter((id, i) => ids.indexOf(id) !== i);
      fail('Gate cache: no duplicate ids (shared subexpressions)', `Duplicate ids: ${[...new Set(dups)].join(', ')}`);
    } else {
      pass('Gate cache: no duplicate ids (shared subexpressions)');
    }
  } catch (e) { fail('Gate cache: no duplicate ids (shared subexpressions)', `Exception: ${e.message}`); }

  // ── SUMMARY ──────────────────────────────────────────────────────────────
  const total  = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  console.log('\n' + '─'.repeat(70));
  console.log(BOLD('SUMMARY'));
  console.log(`  Total: ${total}   ${GREEN('Passed: ' + passed)}   ${failed.length > 0 ? RED('Failed: ' + failed.length) : GREEN('Failed: 0')}`);

  if (failed.length > 0) {
    console.log('\n' + BOLD(RED('FAILURES:')));
    failed.forEach((f) => {
      console.log(`  ${RED('✗')} ${f.name}`);
      console.log(`    ${f.reason}`);
    });
    process.exitCode = 1;
  } else {
    console.log('\n' + GREEN('All tests passed!'));
  }
})();
