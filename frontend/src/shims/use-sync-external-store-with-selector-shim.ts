// Local ESM shim replacing the CJS `use-sync-external-store/shim/with-selector`
// package. See use-sync-external-store-shim.ts in this directory for the full
// explanation of why this is necessary (dual-React-instance bug caused by
// Vite's module-federation plugin being unable to rewrite a `require("react")`
// buried inside a bundled CJS dependency).
//
// This re-implements the memoized-selector wrapper around React 19's native
// `useSyncExternalStore`, matching the same public API as
// `use-sync-external-store/shim/with-selector` (used by
// @base-ui/utils/store/useStore's legacy/pre-19 code path).
import * as React from "react";

export function useSyncExternalStoreWithSelector<Snapshot, Selection>(
  subscribe: (onStoreChange: () => void) => () => void,
  getSnapshot: () => Snapshot,
  getServerSnapshot: (() => Snapshot) | undefined,
  selector: (snapshot: Snapshot) => Selection,
  isEqual?: (a: Selection, b: Selection) => boolean,
): Selection {
  const instRef = React.useRef<{ hasValue: boolean; value: Selection | null }>(
    { hasValue: false, value: null },
  );
  const inst = instRef.current;

  const [getSelection, getServerSelection] = React.useMemo(() => {
    let hasMemo = false;
    let memoizedSnapshot: Snapshot;
    let memoizedSelection: Selection;

    const memoizedSelector = (nextSnapshot: Snapshot): Selection => {
      if (!hasMemo) {
        hasMemo = true;
        memoizedSnapshot = nextSnapshot;
        const nextSelection = selector(nextSnapshot);
        if (isEqual !== undefined && inst.hasValue) {
          const currentSelection = inst.value as Selection;
          if (isEqual(currentSelection, nextSelection)) {
            memoizedSelection = currentSelection;
            return memoizedSelection;
          }
        }
        memoizedSelection = nextSelection;
        return memoizedSelection;
      }

      const currentSelection = memoizedSelection;
      if (Object.is(memoizedSnapshot, nextSnapshot)) {
        return currentSelection;
      }
      const nextSelection = selector(nextSnapshot);
      if (isEqual !== undefined && isEqual(currentSelection, nextSelection)) {
        memoizedSnapshot = nextSnapshot;
        return currentSelection;
      }
      memoizedSnapshot = nextSnapshot;
      memoizedSelection = nextSelection;
      return memoizedSelection;
    };

    const maybeGetServerSnapshot =
      getServerSnapshot === undefined ? null : getServerSnapshot;

    return [
      () => memoizedSelector(getSnapshot()),
      maybeGetServerSnapshot === null
        ? undefined
        : () => memoizedSelector(maybeGetServerSnapshot()),
    ] as const;
  }, [getSnapshot, getServerSnapshot, selector, isEqual]);

  const value = React.useSyncExternalStore(
    subscribe,
    getSelection,
    getServerSelection,
  );

  React.useEffect(() => {
    inst.hasValue = true;
    inst.value = value;
  }, [value, inst]);

  React.useDebugValue(value);
  return value;
}
