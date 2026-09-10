import { createHash } from 'node:crypto'

/** Shared tracked-worktree digest format; ABSENT is the deletion marker. */
export function digestTrackedFiles(files, readCurrent) {
	const h = createHash('sha256')
	for (const file of [...files].sort()) {
		h.update(file); h.update('\0')
		const bytes = readCurrent(file)
		h.update(bytes === null ? 'ABSENT' : createHash('sha256').update(bytes).digest('hex'))
		h.update('\n')
	}
	return h.digest('hex')
}

export async function digestTrackedFilesAsync(files, readCurrent) {
	const h = createHash('sha256')
	for (const file of [...files].sort()) {
		h.update(file); h.update('\0')
		const bytes = await readCurrent(file)
		h.update(bytes === null ? 'ABSENT' : createHash('sha256').update(bytes).digest('hex'))
		h.update('\n')
	}
	return h.digest('hex')
}
