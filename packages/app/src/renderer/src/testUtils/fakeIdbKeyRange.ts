/**
 * jsdom has no IndexedDB. Test files that hand-roll a fake object store for chatStorage install
 * this IDBKeyRange so the scoped readers can build their key range; the fake store's
 * getAll(range) / openCursor(range) must then filter with `includes`.
 *
 * Only string keys are supported: IndexedDB orders them by UTF-16 code unit, exactly like the
 * JavaScript relational operators.
 */
export class FakeIDBKeyRange {
  private constructor(
    readonly lower: string,
    readonly upper: string,
    readonly lowerOpen: boolean,
    readonly upperOpen: boolean
  ) {}

  static bound(
    lower: string,
    upper: string,
    lowerOpen = false,
    upperOpen = false
  ): FakeIDBKeyRange {
    if (typeof lower !== 'string' || typeof upper !== 'string' || lower > upper) {
      throw new DOMException('The parameter is not a valid key range.', 'DataError')
    }
    return new FakeIDBKeyRange(lower, upper, lowerOpen, upperOpen)
  }

  static only(value: string): FakeIDBKeyRange {
    return FakeIDBKeyRange.bound(value, value)
  }

  includes(key: unknown): boolean {
    if (typeof key !== 'string') return false
    const aboveLower = this.lowerOpen ? key > this.lower : key >= this.lower
    const belowUpper = this.upperOpen ? key < this.upper : key <= this.upper
    return aboveLower && belowUpper
  }
}

/** Not vi.stubGlobal: it must survive vi.unstubAllGlobals() between the tests of a file. */
export function installFakeIDBKeyRange(): void {
  Object.defineProperty(globalThis, 'IDBKeyRange', {
    configurable: true,
    writable: true,
    value: FakeIDBKeyRange
  })
}
