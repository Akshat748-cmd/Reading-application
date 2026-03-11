export interface Book {
  id: string;
  title: string;
  authors: string[];
  description: string;
  thumbnail: string;
}

export async function searchBooks(query: string): Promise<Book[]> {
  if (!query) return [];
  
  const apiKey = import.meta.env.VITE_GOOGLE_BOOKS_API_KEY;
  if (!apiKey) {
    throw new Error("Google Books API Key is missing. Please set VITE_VITE_GOOGLE_BOOKS_API_KEY in the Secrets panel.");
  }
  
  const response = await fetch(
    `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&key=${apiKey}`
  );
  
  const data = await response.json();
  
  if (!data.items) return [];
  
  return data.items.map((item: any) => ({
    id: item.id,
    title: item.volumeInfo.title,
    authors: item.volumeInfo.authors || [],
    description: item.volumeInfo.description || '',
    thumbnail: item.volumeInfo.imageLinks?.thumbnail || 'https://picsum.photos/seed/book/200/300'
  }));
}
