/** Find every non-overlapping occurrence of a configured keyword. */
export function findKeywordMatches(text, keyword, caseSensitive = false, wholeWord = false) {
  const matches = [];
  if (!text || !keyword) return matches;

  const searchText = caseSensitive ? text : text.toLowerCase();
  const searchKeyword = caseSensitive ? keyword : keyword.toLowerCase();

  if (wholeWord) {
    const regex = new RegExp(`\\b${escapeRegex(searchKeyword)}\\b`, caseSensitive ? 'g' : 'gi');
    let match;
    while ((match = regex.exec(text)) !== null) {
      matches.push({ text: match[0], position: match.index });
    }
    return matches;
  }

  let position = 0;
  while ((position = searchText.indexOf(searchKeyword, position)) !== -1) {
    matches.push({ text: text.substr(position, keyword.length), position });
    position += keyword.length;
  }
  return matches;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
