# SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
# Proprietary: made available for inspection only. See LICENSE.
"""Development-only equivalence checks for SCCE's existing scalar ProgramExpression IR."""

import argparse
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import re
import struct
import sys
import time


class Unsupported(Exception):
    pass


MAX_INPUT_BYTES = 1_048_576
MAX_NODES = 1024
MAX_DEPTH = 64
MAX_BINDINGS = 128
MAX_ARGUMENTS = 8
LOCK = Path(__file__).with_name("requirements.lock")
VERSION = "4.16.0.0"


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def file_sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path):
    with Path(path).open("rb") as stream:
        raw = stream.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise Unsupported("input exceeds the declared byte budget")
    def invalid_constant(value):
        raise ValueError("non-JSON numeric constant: " + value)
    value = json.loads(raw.decode("utf-8-sig"), parse_int=lambda text: -0.0 if text == "-0" else int(text),
                       parse_constant=invalid_constant)
    return value, sha256(raw)


def bits_of(value):
    return int.from_bytes(struct.pack(">d", float(value)), "big")


def number_from_bits(text):
    if not isinstance(text, str) or not re.fullmatch(r"[0-9a-fA-F]{16}", text):
        raise ValueError("binary64 bits must be exactly 16 hexadecimal digits")
    value = struct.unpack(">d", bytes.fromhex(text))[0]
    if not math.isfinite(value):
        raise ValueError("argument domains and their bounds must be finite binary64 values")
    return value


def require_keys(value, allowed, required, label):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        raise ValueError(label + " has missing or unknown fields")


class Encoder:
    def __init__(self, z3):
        self.z3 = z3
        self.sort = z3.Float64()
        self.rounding = z3.RNE()
        self.nodes = 0

    def numeric(self, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise Unsupported("only finite numeric literals and Boolean values are supported")
        return self.z3.fpBVToFP(self.z3.BitVecVal(bits_of(value), 64), self.sort)

    def expect_number(self, value):
        if not self.z3.is_fp(value):
            raise Unsupported("numeric operator received a nonnumeric expression")
        return value

    def minimum_maximum(self, left, right, minimum):
        z3 = self.z3
        both_zero = z3.And(z3.fpIsZero(left), z3.fpIsZero(right))
        negative_zero = z3.Or(z3.fpIsNegative(left), z3.fpIsNegative(right)) if minimum else z3.And(z3.fpIsNegative(left), z3.fpIsNegative(right))
        zero = z3.If(negative_zero, z3.fpMinusZero(self.sort), z3.fpPlusZero(self.sort))
        ordered = z3.If(z3.fpLT(left, right) if minimum else z3.fpGT(left, right), left, right)
        return z3.If(z3.Or(z3.fpIsNaN(left), z3.fpIsNaN(right)), z3.fpNaN(self.sort), z3.If(both_zero, zero, ordered))

    def expression(self, value, arguments, depth=0):
        self.nodes += 1
        if self.nodes > MAX_NODES or depth > MAX_DEPTH:
            raise Unsupported("IR exceeds the declared node/depth budget")
        if not isinstance(value, dict):
            raise Unsupported("ProgramExpression must be an object")
        z3 = self.z3
        kind = value.get("kind")
        fields = {
            "argument": ("kind", "index"), "literal": ("kind", "value"), "value": ("kind", "value"),
            "unary": ("kind", "operator", "operand"), "binary": ("kind", "operator", "left", "right"),
            "equivalent": ("kind", "left", "right"), "comparison": ("kind", "operator", "left", "right"),
            "conditional": ("kind", "condition", "whenTrue", "whenFalse"),
        }
        if kind not in fields:
            raise Unsupported("unsupported ProgramExpression kind: " + str(kind))
        require_keys(value, fields[kind], fields[kind], "ProgramExpression " + kind)
        child = lambda name: self.expression(value[name], arguments, depth + 1)
        if kind == "argument":
            index = value["index"]
            if isinstance(index, bool) or not isinstance(index, int) or not 0 <= index < len(arguments):
                raise Unsupported("argument references a missing parameter or a future local binding")
            return arguments[index]
        if kind in ("literal", "value"):
            if kind == "value" and isinstance(value["value"], bool):
                return z3.BoolVal(value["value"])
            return self.numeric(value["value"])
        if kind == "unary":
            if value["operator"] != "negate":
                raise Unsupported("unsupported unary operator")
            return z3.fpNeg(self.expect_number(child("operand")))
        if kind == "conditional":
            condition, yes, no = child("condition"), child("whenTrue"), child("whenFalse")
            if not z3.is_bool(condition) or yes.sort() != no.sort():
                raise Unsupported("conditional requires a Boolean condition and identically typed branches")
            return z3.If(condition, yes, no)
        left, right = child("left"), child("right")
        if kind == "equivalent":
            if left.sort() != right.sort():
                return z3.BoolVal(False)
            return z3.fpEQ(left, right) if z3.is_fp(left) else left == right
        left, right = self.expect_number(left), self.expect_number(right)
        operator = value["operator"]
        if kind == "comparison":
            comparisons = {"less": z3.fpLT, "less_or_equal": z3.fpLEQ, "greater": z3.fpGT, "greater_or_equal": z3.fpGEQ}
            if operator not in comparisons:
                raise Unsupported("unsupported comparison operator")
            return comparisons[operator](left, right)
        arithmetic = {"add": z3.fpAdd, "subtract": z3.fpSub, "multiply": z3.fpMul, "divide": z3.fpDiv}
        if operator in arithmetic:
            return arithmetic[operator](self.rounding, left, right)
        if operator in ("minimum", "maximum"):
            return self.minimum_maximum(left, right, operator == "minimum")
        raise Unsupported("unsupported binary operator: " + str(operator))

    def program(self, value, arguments):
        if not isinstance(value, dict):
            raise Unsupported("program must be an existing expression, transformation candidate, or source construction")
        expression = value.get("producedIr", value.get("expression", value if "kind" in value else None))
        bindings = value.get("bindings", [])
        if not isinstance(bindings, list) or len(bindings) > MAX_BINDINGS:
            raise Unsupported("local bindings exceed the declared budget")
        values = list(arguments)
        for binding in bindings:
            values.append(self.expression(binding, values))
        return self.expression(expression, values)


def domain_constraints(z3, domain, arity, sort):
    require_keys(domain, ("arguments",), ("arguments",), "domain")
    rows = domain["arguments"]
    if not isinstance(rows, list) or len(rows) != arity:
        raise ValueError("domain requires one explicit argument domain per source parameter")
    bits, arguments, constraints = [], [], []
    for index, row in enumerate(rows):
        require_keys(row, ("kind", "valuesBits", "minimumBits", "maximumBits"), ("kind",), "argument domain")
        if row["kind"] != "finite_binary64":
            raise Unsupported("only explicit finite_binary64 argument domains are supported")
        variable = z3.BitVec("argument_" + str(index), 64)
        argument = z3.fpBVToFP(variable, sort)
        constraints.append(z3.Extract(62, 52, variable) != z3.BitVecVal(2047, 11))
        if "valuesBits" in row:
            if "minimumBits" in row or "maximumBits" in row or not isinstance(row["valuesBits"], list) or not row["valuesBits"]:
                raise ValueError("enumerated domains must be nonempty and cannot also have interval bounds")
            if len(row["valuesBits"]) > MAX_NODES:
                raise Unsupported("enumerated argument domain exceeds the declared node budget")
            for text in row["valuesBits"]:
                number_from_bits(text)
            constraints.append(z3.Or(*[variable == z3.BitVecVal(int(text, 16), 64) for text in row["valuesBits"]]))
        elif "minimumBits" in row or "maximumBits" in row:
            if "minimumBits" not in row or "maximumBits" not in row:
                raise ValueError("interval domains require both exact binary64 bounds")
            minimum, maximum = number_from_bits(row["minimumBits"]), number_from_bits(row["maximumBits"])
            if minimum > maximum:
                raise ValueError("empty interval domain")
            lower = z3.fpBVToFP(z3.BitVecVal(int(row["minimumBits"], 16), 64), sort)
            upper = z3.fpBVToFP(z3.BitVecVal(int(row["maximumBits"], 16), 64), sort)
            constraints.extend((z3.fpGEQ(argument, lower), z3.fpLEQ(argument, upper)))
        bits.append(variable)
        arguments.append(argument)
    return bits, arguments, constraints


def observable_equal(z3, left, right):
    if left.sort() != right.sort():
        return z3.BoolVal(False)
    if z3.is_bool(left):
        return left == right
    return z3.Or(z3.And(z3.fpIsNaN(left), z3.fpIsNaN(right)),
                 z3.And(z3.Not(z3.fpIsNaN(left)), z3.Not(z3.fpIsNaN(right)), z3.fpToIEEEBV(left) == z3.fpToIEEEBV(right)))


def number_receipt(bits):
    value = struct.unpack(">d", bits.to_bytes(8, "big"))[0]
    text = "NaN" if math.isnan(value) else "+Infinity" if value == math.inf else "-Infinity" if value == -math.inf else "-0" if bits == 0x8000000000000000 else repr(value)
    return {"kind": "number", "bits": format(bits, "016x"), "numberText": text}


def model_value(z3, model, expression):
    if z3.is_bool(expression):
        return {"kind": "boolean", "value": z3.is_true(model.eval(expression, model_completion=True))}
    if z3.is_true(model.eval(z3.fpIsNaN(expression), model_completion=True)):
        return {"kind": "number", "numberText": "NaN", "nanPayload": "not_observed"}
    return number_receipt(model.eval(z3.fpToIEEEBV(expression), model_completion=True).as_long())


def bounded_integer(minimum, maximum):
    def parse(text):
        value = int(text)
        if not minimum <= value <= maximum:
            raise argparse.ArgumentTypeError("must be between " + str(minimum) + " and " + str(maximum))
        return value
    return parse


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-encoding", required=True, help="existing SourceCodeFunctionConstruction JSON")
    parser.add_argument("--candidate", required=True, help="existing ProgramExpression, transformation candidate, or source construction JSON")
    parser.add_argument("--domain", required=True, help="explicit binary64 argument domains JSON")
    parser.add_argument("--timeout-ms", type=bounded_integer(1, 60000), default=2000)
    parser.add_argument("--rlimit", type=bounded_integer(1, 10000000), default=1000000)
    parser.add_argument("--memory-mb", type=bounded_integer(32, 512), default=256)
    options = parser.parse_args()
    started = time.monotonic()
    receipt = {"schema": "scce.solver_check_receipt.v1", "developmentOnly": True,
               "scope": {"ir": "ProgramExpression / SourceCodeFunctionConstruction binding DAG", "semantics": "isolated JavaScript Number binary64 and Boolean expressions",
                         "rounding": "roundNearestTiesToEven", "outputEquality": "Object.is: signed zeros distinct; all NaNs one observable class",
                         "sourceEncodingAssumption": "existing source compiler translation; standard unmodified Math; no proof of parser or compiler correctness",
                         "nativeCompilerAndTests": "remain authoritative; not executed by this solver CLI", "wholeProgramProof": False,
                         "nonfiniteResults": "IEEE NaN and infinities retained",
                         "admissionAndFitPolicies": "not checked; JavaScript source/emission arithmetic, not finite-result rejection or epsilon-based fit evaluation"},
               "limits": {"timeoutMs": options.timeout_ms, "rlimit": options.rlimit, "z3MemoryMiB": options.memory_mb,
                          "inputBytesPerFile": MAX_INPUT_BYTES, "irNodes": MAX_NODES, "irDepth": MAX_DEPTH,
                          "localBindingsPerProgram": MAX_BINDINGS, "arguments": MAX_ARGUMENTS}}
    try:
        import z3
        installed = importlib.metadata.version("z3-solver")
        lock_bytes = LOCK.read_bytes()
        locked = re.search(rb"(?m)^z3-solver==([0-9.]+) --hash=sha256:([0-9a-f]{64})\s*$", lock_bytes)
        if not locked or locked.group(1).decode("ascii") != VERSION:
            raise Unsupported("requirements lock does not match the supported solver version")
        native_artifacts = sorted(path for path in Path(z3.__file__).parent.joinpath("lib").glob("*z3*") if path.suffix in (".dll", ".so", ".dylib"))
        receipt["solver"] = {"name": "z3-solver", "packageVersion": installed, "version": z3.get_full_version(),
                             "requirementsLockSha256": sha256(lock_bytes), "lockedWheelSha256": locked.group(2).decode("ascii"),
                             "bindingSha256": file_sha256(z3.z3.__file__),
                             "packageNativeArtifacts": [{"name": path.name, "sha256": file_sha256(path)} for path in native_artifacts]}
        if installed != VERSION:
            raise Unsupported("installed solver differs from the pinned development solver version")
        z3.set_param("memory_max_size", options.memory_mb)
        source, source_sha = read_json(options.source_encoding)
        candidate, candidate_sha = read_json(options.candidate)
        domain, domain_sha = read_json(options.domain)
        receipt["inputs"] = {"sourceEncodingSha256": source_sha, "candidateSha256": candidate_sha, "domainSha256": domain_sha}
        receipt["domain"] = domain
        if not isinstance(source, dict) or source.get("schema") != "scce.source_code_function_construction.v1":
            raise Unsupported("source encoding must be an existing SourceCodeFunctionConstruction")
        if source.get("languageId") not in ("javascript", "typescript"):
            raise Unsupported("this scope encodes JavaScript/TypeScript Number semantics only")
        if not isinstance(source.get("parameters"), list) or len(source["parameters"]) > MAX_ARGUMENTS or not isinstance(source.get("sourceText"), str):
            raise Unsupported("source construction lacks bounded parameters or exact source text")
        receipt["source"] = {key: source.get(key) for key in ("id", "languageId", "sourceHash", "sourceStart", "sourceEnd", "callable")}
        receipt["source"]["sourceTextSha256"] = sha256(source["sourceText"].encode("utf-8"))
        encoder = Encoder(z3)
        bits, arguments, constraints = domain_constraints(z3, domain, len(source["parameters"]), encoder.sort)
        reference, proposed = encoder.program(source, arguments), encoder.program(candidate, arguments)
        solver = z3.SolverFor("QF_FPBV")
        solver.set(timeout=options.timeout_ms, rlimit=options.rlimit)
        solver.add(*constraints, z3.Not(observable_equal(z3, reference, proposed)))
        receipt["querySha256"] = sha256(solver.sexpr().encode("utf-8"))
        receipt["encodedNodes"] = encoder.nodes
        result = solver.check()
        receipt["status"] = str(result)
        if result == z3.sat:
            model = solver.model()
            receipt["counterexample"] = {"arguments": [number_receipt(model.eval(value, model_completion=True).as_long()) for value in bits],
                                         "source": model_value(z3, model, reference), "candidate": model_value(z3, model, proposed)}
            receipt["claim"] = "different observable results in the explicit domain of the supported scalar encoding"
        elif result == z3.unsat:
            receipt["claim"] = "equivalent within the explicit domain of the supported scalar encoding"
        else:
            receipt["reason"] = solver.reason_unknown()
            receipt["claim"] = "inconclusive; no equivalence or counterexample established"
    except Unsupported as error:
        receipt.update(status="unsupported", reason=str(error), claim="no equivalence check completed")
    except Exception as error:
        receipt.update(status="error", reason=type(error).__name__ + ": " + str(error), claim="no equivalence check completed")
    receipt["elapsedMs"] = round((time.monotonic() - started) * 1000, 3)
    print(json.dumps(receipt, ensure_ascii=True, allow_nan=False, separators=(",", ":")))
    return {"unsat": 0, "sat": 1, "unknown": 2, "unsupported": 3, "error": 4}[receipt["status"]]


if __name__ == "__main__":
    sys.exit(main())
