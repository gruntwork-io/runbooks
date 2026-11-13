import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react"

/** The files a block last wrote into a clone. */
export interface BlockWrite {
  readonly blockId: string
  /** What the files panel calls the block, such as its title. */
  readonly label: string
  /** The clone the files are in. */
  readonly worktreePath: string
  /** The files, from the clone's root. */
  readonly paths: readonly string[]
}

interface BlockWritesContextType {
  /** Each block's last write, in the order the blocks first wrote. */
  readonly writes: readonly BlockWrite[]
  /** Records a block's write, in place of the one before it. */
  readonly recordWrite: (write: BlockWrite) => void
}

const NO_WRITES: BlockWritesContextType = { writes: [], recordWrite: () => {} }

// Without a provider there's no files panel to tell which block wrote a file.
const BlockWritesContext = createContext<BlockWritesContextType>(NO_WRITES)

/** Remembers which files each block wrote, so the files panel can show one block's. */
export function BlockWritesProvider({ children }: { children: ReactNode }) {
  const [writes, setWrites] = useState<readonly BlockWrite[]>([])
  const recordWrite = useCallback((write: BlockWrite) => {
    setWrites((prev) =>
      prev.some((w) => w.blockId === write.blockId)
        ? prev.map((w) => (w.blockId === write.blockId ? write : w))
        : [...prev, write],
    )
  }, [])
  const value = useMemo(() => ({ writes, recordWrite }), [writes, recordWrite])
  return <BlockWritesContext.Provider value={value}>{children}</BlockWritesContext.Provider>
}

export function useBlockWrites(): BlockWritesContextType {
  return useContext(BlockWritesContext)
}
