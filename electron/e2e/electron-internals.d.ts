// Electron internals the e2e specs read but Electron's published types leave
// out. They can change in any Electron release; a spec failing after an
// upgrade may mean one of these moved.
declare namespace Electron {
  interface WebContents {
    /** The webPreferences this contents was created with. */
    getLastWebPreferences(): WebPreferences | null
  }
}
