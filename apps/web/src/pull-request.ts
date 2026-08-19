/** The most a pull request number can be before it is plainly a typo. */
const highestNumber = 1_000_000;

export interface PullRequestReference {
  number: number;
  /**
   * `github.com/owner/repo`, in the shape of a project's id, when the query
   * named a repository. A pasted URL does; a bare `#123` means "here".
   */
  projectId?: string;
}

/**
 * What somebody typed into the branch search, read as a pull request when it
 * can be. A whole URL is what a pull request is usually passed around as, and
 * `#123` is what it is called in conversation — both name the same thing, so
 * both are recognised rather than searched for as text.
 */
export function pullRequestReference(
  query: string,
): PullRequestReference | undefined {
  const text = query.trim();
  if (!text) return undefined;
  const url = text.match(
    /^(?:https?:\/\/)?([\w-]+(?:\.[\w-]+)+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/i,
  );
  if (url) return reference(url[4], `${url[1]}/${url[2]}/${url[3]}`);
  const slug = text.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/);
  if (slug) return reference(slug[3], `github.com/${slug[1]}/${slug[2]}`);
  const bare = text.match(/^#?(\d+)$/);
  if (bare) return reference(bare[1]);
  return undefined;
}

function reference(
  digits: string | undefined,
  projectId?: string,
): PullRequestReference | undefined {
  const number = Number(digits);
  if (!Number.isInteger(number) || number < 1 || number > highestNumber) {
    return undefined;
  }
  return projectId
    ? { number, projectId: projectId.toLowerCase() }
    : { number };
}
