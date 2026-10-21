// Sequential async helpers. The host admits only a few concurrent operations per owner, so each
// item waits for the previous one; reduce keeps that explicit without await inside a loop.

export function mapSeries(items, mapper) {
  return items.reduce(async (previous, item) => {
    const done = await previous
    done.push(await mapper(item))
    return done
  }, Promise.resolve([]))
}

// Resolves to the first non-null result of `finder`, checking items one at a time.
export function findSeries(items, finder) {
  return items.reduce(
    async (previous, item) => (await previous) ?? finder(item),
    Promise.resolve(null),
  )
}
