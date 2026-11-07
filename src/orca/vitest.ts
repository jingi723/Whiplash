// The subset of vitest that Orca's lifted tests use, on node:test, so they run unchanged.
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it as nodeIt } from 'node:test'

export { afterEach, beforeEach, describe }

type Body = () => void | Promise<void>

function format(name: string, row: unknown): string {
  if (!Array.isArray(row)) {
    // Object rows name their fields with `$field`, as vitest does.
    return name.replace(/\$(\w+)/g, (whole, key) =>
      row && typeof row === 'object' && key in row ? String((row as Record<string, unknown>)[key]) : whole
    )
  }
  let index = 0
  return name.replace(/%[sdiop]/g, () => String(row[index++]))
}

export const it = Object.assign((name: string, body: Body) => nodeIt(name, body), {
  each:
    <Row>(rows: readonly Row[]) =>
    (name: string, body: (...row: any[]) => unknown) => {
      for (const row of rows) {
        const args = Array.isArray(row) ? row : [row]
        nodeIt(format(name, row), () => body(...args) as void | Promise<void>)
      }
    }
})

/** vitest's toEqual ignores undefined properties; node's deepStrictEqual does not. */
function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutUndefined)
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, withoutUndefined(entry)])
    )
  }
  return value
}

function matchesObject(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((entry, index) => matchesObject(actual[index], entry))
    )
  }
  if (expected && typeof expected === 'object') {
    return (
      !!actual &&
      typeof actual === 'object' &&
      Object.entries(expected).every(([key, entry]) =>
        matchesObject((actual as Record<string, unknown>)[key], entry)
      )
    )
  }
  return Object.is(actual, expected)
}

function matchers(actual: any) {
  return {
    toBe: (expected: unknown) => assert.equal(actual, expected),
    toEqual: (expected: unknown) => assert.deepStrictEqual(withoutUndefined(actual), withoutUndefined(expected)),
    toBeNull: () => assert.equal(actual, null),
    toBeGreaterThan: (expected: number) => assert.ok(actual > expected, `${actual} > ${expected}`),
    toBeLessThanOrEqual: (expected: number) => assert.ok(actual <= expected, `${actual} <= ${expected}`),
    toContain: (expected: unknown) => assert.ok(actual.includes(expected), `contains ${String(expected)}`),
    toMatchObject: (expected: unknown) =>
      assert.ok(matchesObject(actual, expected), `${JSON.stringify(actual)} matches ${JSON.stringify(expected)}`),
    not: {
      toBeNull: () => assert.notEqual(actual, null),
      toContain: (expected: unknown) => assert.ok(!actual.includes(expected), `does not contain ${String(expected)}`)
    }
  }
}

type Matchers = ReturnType<typeof matchers>

export function expect(actual: any): Matchers & { resolves: { [K in keyof Matchers]: (...args: any[]) => Promise<void> } } {
  const resolves = new Proxy({} as { [K in keyof Matchers]: (...args: any[]) => Promise<void> }, {
    get: (_target, key) => async (...args: unknown[]) => (matchers(await actual) as any)[key](...args)
  })
  return { ...matchers(actual), resolves }
}
