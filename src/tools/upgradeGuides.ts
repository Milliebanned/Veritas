export async function findUpgradeGuides(
  owner: string,
  repo: string,
  get: (url: string) => Promise<{ status: number; text: string }>
): Promise<{ url: string; text: string }[]> {
  try {
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
    const treeResponse = await get(treeUrl);
    if (treeResponse.status !== 200) {
      return [];
    }

    const data = JSON.parse(treeResponse.text);
    if (!data || !Array.isArray(data.tree)) {
      return [];
    }

    interface TreeItem {
      path: string;
      type: string;
    }

    const markdownFiles = (data.tree as TreeItem[])
      .filter(item => {
        const isMarkdown = item.path.toLowerCase().endsWith('.md') || item.path.toLowerCase().endsWith('.markdown');
        return isMarkdown && /upgrad|migrat/i.test(item.path);
      })
      .sort((a, b) => a.path.length - b.path.length)
      .slice(0, 3);

    const results: { url: string; text: string }[] = [];

    for (const file of markdownFiles) {
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${file.path}`;
      const fileResponse = await get(rawUrl);
      if (fileResponse.status === 200) {
        results.push({
          url: `https://github.com/${owner}/${repo}/blob/HEAD/${file.path}`,
          text: fileResponse.text
        });
      }
    }

    return results;
  } catch (error) {
    return [];
  }
}
