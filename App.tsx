import React, { useState, useRef } from 'react';
import { 
  BookOpen, 
  Network, 
  Plus, 
  Send, 
  Loader2, 
  ChevronRight, 
  ChevronLeft,
  Info,
  Download,
  Trash2,
  Edit3,
  Eye,
  Search,
  Save,
  Library,
  X,
  Share2,
  FileText,
  Image as ImageIcon,
  FileJson,
  Sparkles,
  TrendingUp
} from 'lucide-react';
import Markdown from 'react-markdown';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI } from "@google/genai";
import { extractMindMap, expandConcept } from './services/gemini';
import { MindMapData, MindMapNode } from './types';
import { MindMap, MindMapRef } from './components/MindMap';
import { searchBooks, Book } from './services/googleBooks';
import { getDb } from './services/firebase';
import { collection, addDoc, getDocs, query, orderBy } from 'firebase/firestore';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { saveAs } from 'file-saver';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function App() {
  const apiKey = process.env.GEMINI_API_KEY || "";
  const [inputText, setInputText] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [mindMapData, setMindMapData] = useState<MindMapData | null>(null);
  const [selectedNode, setSelectedNode] = useState<MindMapNode | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [viewMode, setViewMode] = useState<'edit' | 'read'>('edit');
  
  // New states for Book Search and Firebase
  const [isSearchModalOpen, setIsSearchModalOpen] = useState(false);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);
  const [libraryItems, setLibraryItems] = useState<any[]>([]);
  const [isLoadingLibrary, setIsLoadingLibrary] = useState(false);
  const [isRefreshingLibrary, setIsRefreshingLibrary] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Book[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [generatedTopicImage, setGeneratedTopicImage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [expandedContent, setExpandedContent] = useState<{ 
    text: string; 
    links?: { uri: string; title: string }[];
    trendingQueries?: string[];
  } | null>(null);
  const [isExpanding, setIsExpanding] = useState(false);
  const [expansionCache, setExpansionCache] = useState<Record<string, { 
    text: string; 
    links?: { uri: string; title: string }[];
    trendingQueries?: string[];
  }>>({});
  const [isInfoModalOpen, setIsInfoModalOpen] = useState(false);
  const [activeTopic, setActiveTopic] = useState<string>('');
  const articleRef = useRef<HTMLDivElement>(null);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mindMapRef = useRef<MindMapRef>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const results = await searchBooks(searchQuery);
      setSearchResults(results);
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setIsSearching(false);
    }
  };

  const selectBook = (book: Book) => {
    setInputText(`# ${book.title}\n\n**Authors:** ${book.authors.join(', ')}\n\n${book.description}`);
    setIsSearchModalOpen(false);
    setViewMode('edit');
  };

  const handleSave = async () => {
    if (!mindMapData) return;
    setIsSaving(true);
    
    const newMap = {
      id: `map-${Date.now()}`,
      data: mindMapData,
      text: inputText,
      createdAt: new Date().toISOString(),
      title: mindMapData.nodes.find(n => n.type === 'root')?.label || 'Untitled Map'
    };

    try {
      // 1. Save to Backend (Permanent)
      const response = await fetch('/api/mindmaps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newMap)
      });

      if (!response.ok) throw new Error('Backend save failed');

      // 2. Save to LocalStorage as fallback
      const localMaps = JSON.parse(localStorage.getItem('mindmaps_local') || '[]');
      localStorage.setItem('mindmaps_local', JSON.stringify([newMap, ...localMaps]));

      // 3. Update library state
      setLibraryItems(prev => [{ ...newMap, source: 'backend' }, ...prev]);

      // 4. Firebase sync (optional background)
      const syncToCloud = async () => {
        try {
          const db = getDb();
          await addDoc(collection(db, 'mindmaps'), newMap);
        } catch (firebaseError) {
          console.warn('Firebase sync failed:', firebaseError);
        }
      };
      syncToCloud();

      setIsSaving(false);
      showToast('Mind map saved successfully!');
    } catch (error) {
      console.error('Save failed:', error);
      showToast('Saved locally (Cloud sync failed)', 'error');
      setIsSaving(false);
    }
  };

  const fetchLibrary = async (isRefresh = false) => {
    if (isRefresh) {
      setIsRefreshingLibrary(true);
    } else if (libraryItems.length === 0) {
      setIsLoadingLibrary(true);
    }
    
    try {
      // Parallelize all fetches for maximum speed
      const [backendRes, firebaseRes, localRes] = await Promise.allSettled([
        fetch('/api/mindmaps').then(res => res.ok ? res.json() : []),
        (async () => {
          try {
            const db = getDb();
            const q = query(collection(db, 'mindmaps'), orderBy('createdAt', 'desc'));
            const querySnapshot = await getDocs(q);
            return querySnapshot.docs.map(doc => ({
              id: doc.id,
              source: 'firebase',
              ...doc.data()
            }));
          } catch (e) { return []; }
        })(),
        Promise.resolve(JSON.parse(localStorage.getItem('mindmaps_local') || '[]').map((item: any, index: number) => ({
          ...item,
          id: item.id || `local-${index}`,
          source: 'local'
        })))
      ]);

      const items = backendRes.status === 'fulfilled' ? backendRes.value : [];
      const firebaseItems = firebaseRes.status === 'fulfilled' ? firebaseRes.value : [];
      const localItems = localRes.status === 'fulfilled' ? localRes.value : [];

      // Combine and deduplicate
      const combined = [...items, ...firebaseItems, ...localItems];
      const unique = Array.from(new Map(combined.map(item => [item.id || item.createdAt, item])).values());
      
      unique.sort((a: any, b: any) => 
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );

      setLibraryItems(unique);
      if (isRefresh) showToast('Library refreshed!');
    } catch (error) {
      console.error('Failed to fetch library:', error);
    } finally {
      setIsLoadingLibrary(false);
      setIsRefreshingLibrary(false);
    }
  };

  const deleteFromLibrary = async (e: React.MouseEvent, item: any) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this mind map?')) return;

    try {
      if (item.source === 'backend') {
        await fetch(`/api/mindmaps/${item.id}`, { method: 'DELETE' });
      }

      if (item.source === 'local' || item.source === 'backend') {
        const localMaps = JSON.parse(localStorage.getItem('mindmaps_local') || '[]');
        const filtered = localMaps.filter((m: any) => m.id !== item.id && m.createdAt !== item.createdAt);
        localStorage.setItem('mindmaps_local', JSON.stringify(filtered));
      }
      
      setLibraryItems(prev => prev.filter(i => i.id !== item.id));
    } catch (error) {
      console.error('Delete failed:', error);
      alert('Failed to delete mind map.');
    }
  };

  const loadFromLibrary = (item: any) => {
    setMindMapData(item.data);
    setInputText(item.text);
    setIsLibraryOpen(false);
    setViewMode('read');
  };

  const exportMapAsImage = async () => {
    if (!mindMapRef.current) return;
    try {
      const dataUrl = mindMapRef.current.exportImage();
      if (!dataUrl) throw new Error('Failed to generate image data');
      
      const link = document.createElement('a');
      link.download = `MindMap_${Date.now()}.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error('Map export failed:', err);
      alert('Failed to export map as image.');
    }
  };

  const handleMainShare = async () => {
    if (!mindMapData) {
      alert('Generate a mind map first to share!');
      return;
    }
    
    const title = mindMapData.nodes.find(n => n.type === 'root')?.label || 'My Mind Map';
    
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Mind Map: ${title}`,
          text: `Check out this AI-generated mind map for: ${title}`,
          url: window.location.href
        });
        showToast('Shared successfully!');
      } catch (err) {
        console.error('Share failed:', err);
      }
    } else {
      // Fallback: Copy URL
      navigator.clipboard.writeText(window.location.href);
      showToast('Link copied to clipboard!');
    }
  };

  const handleGenerate = async () => {
    if (!inputText.trim()) return;
    if (inputText.trim().length < 10) {
      alert('Please enter a longer text (at least 10 characters) to generate a meaningful mind map.');
      return;
    }
    setIsLoading(true);
    try {
      const data = await extractMindMap(inputText);
      setMindMapData(data);
      setViewMode('read'); // Switch to read mode after generation

      // Auto-save to history
      const historyMap = {
        id: `map-${Date.now()}`,
        data,
        text: inputText,
        createdAt: new Date().toISOString(),
        title: data.nodes.find(n => n.type === 'root')?.label || 'Untitled Map'
      };
      
      // Background save to backend
      fetch('/api/mindmaps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(historyMap)
      }).catch(err => console.warn('Auto-save failed:', err));

      // Save to local storage
      const localMaps = JSON.parse(localStorage.getItem('mindmaps_local') || '[]');
      localStorage.setItem('mindmaps_local', JSON.stringify([historyMap, ...localMaps]));

    } catch (error: any) {
      console.error('Failed to generate mind map:', error);
      alert(error.message || 'Failed to generate mind map. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClear = () => {
    if (confirm('Are you sure you want to clear the current mind map?')) {
      setMindMapData(null);
      setInputText('');
      setSelectedNode(null);
      setExpandedContent(null);
    }
  };

  const handleExpand = async () => {
    if (!selectedNode) return;
    setActiveTopic(selectedNode.label);
    setGeneratedTopicImage(null); // Reset image for new topic
    
    // Check cache first
    if (expansionCache[selectedNode.id]) {
      setExpandedContent(expansionCache[selectedNode.id]);
      return;
    }

    setIsExpanding(true);
    try {
      const result = await expandConcept(selectedNode.label, inputText);
      setExpandedContent(result);
      // Save to cache
      setExpansionCache(prev => ({
        ...prev,
        [selectedNode.id]: result
      }));
    } catch (error) {
      console.error('Expansion failed:', error);
      alert('Failed to generate study guide. Please try again.');
    } finally {
      setIsExpanding(false);
    }
  };

  const handleRelatedQuery = async (queryText: string) => {
    setActiveTopic(queryText);
    setIsExpanding(true);
    setGeneratedTopicImage(null);
    
    // Scroll article to top
    if (articleRef.current) {
      articleRef.current.parentElement?.scrollTo({ top: 0, behavior: 'smooth' });
    }

    try {
      const result = await expandConcept(queryText, inputText);
      setExpandedContent(result);
    } catch (error) {
      console.error('Related query failed:', error);
      showToast('Failed to fetch information for this query', 'error');
    } finally {
      setIsExpanding(false);
    }
  };

  const generateAIIllustration = async () => {
    if (!selectedNode || !apiKey) return;
    setIsGeneratingImage(true);
    try {
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
          parts: [
            {
              text: `A high-quality, educational illustration representing the concept of "${activeTopic || selectedNode.label}". 
              Style: Clean, modern, 3D isometric or professional infographic style. 
              Vibrant colors, clear focus on the subject, no text in the image.`,
            },
          ],
        },
        config: {
          imageConfig: {
            aspectRatio: "16:9",
          },
        },
      });

      for (const part of response.candidates[0].content.parts) {
        if (part.inlineData) {
          const base64EncodeString = part.inlineData.data;
          setGeneratedTopicImage(`data:image/png;base64,${base64EncodeString}`);
          break;
        }
      }
    } catch (err) {
      console.error('Image generation failed:', err);
      alert('Failed to generate AI illustration. Please try again.');
    } finally {
      setIsGeneratingImage(false);
    }
  };

  const exportAsText = () => {
    if (!expandedContent || !selectedNode) return;
    const title = activeTopic || selectedNode.label;
    const element = document.createElement("a");
    const file = new Blob([`# ${title}\n\n${expandedContent.text}`], {type: 'text/plain'});
    element.href = URL.createObjectURL(file);
    element.download = `${title.replace(/\s+/g, '_')}_Study_Guide.txt`;
    document.body.appendChild(element);
    element.click();
  };

  const exportAsPDF = () => {
    if (!expandedContent || !selectedNode) return;
    const doc = new jsPDF();
    const title = activeTopic || selectedNode.label;
    const content = expandedContent.text;
    
    doc.setFontSize(20);
    doc.text(title, 10, 20);
    doc.setFontSize(12);
    const splitText = doc.splitTextToSize(content, 180);
    doc.text(splitText, 10, 30);
    doc.save(`${title.replace(/\s+/g, '_')}_Study_Guide.pdf`);
  };

  const exportAsImage = async () => {
    if (!articleRef.current || !selectedNode) return;
    const title = activeTopic || selectedNode.label;
    try {
      const dataUrl = await toPng(articleRef.current, { 
        backgroundColor: '#ffffff', 
        quality: 1,
        pixelRatio: 2
      });
      const link = document.createElement('a');
      link.download = `${title.replace(/\s+/g, '_')}_Study_Guide.png`;
      link.href = dataUrl;
      link.click();
    } catch (err) {
      console.error('Image export failed:', err);
      alert('Failed to export as image. Your browser might be blocking the download or the content is too large.');
    }
  };

  const exportAsWord = async () => {
    if (!expandedContent || !selectedNode) return;
    const title = activeTopic || selectedNode.label;
    
    const doc = new Document({
      sections: [{
        properties: {},
        children: [
          new Paragraph({
            text: title,
            heading: HeadingLevel.HEADING_1,
          }),
          ...expandedContent.text.split('\n').map(line => {
            return new Paragraph({
              children: [new TextRun(line)],
              spacing: { before: 200 },
            });
          }),
        ],
      }],
    });

    const blob = await Packer.toBlob(doc);
    saveAs(blob, `${title.replace(/\s+/g, '_')}_Study_Guide.docx`);
  };

  return (
    <div className="flex h-screen bg-slate-50 text-slate-900 font-sans overflow-hidden">
      {/* Sidebar */}
      <motion.aside 
        initial={false}
        animate={{ width: isSidebarOpen ? 400 : 0, opacity: isSidebarOpen ? 1 : 0 }}
        className="bg-white border-r border-slate-200 flex flex-col relative"
      >
        <div className="p-6 flex flex-col h-full">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center text-white">
              <BookOpen size={24} />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">MindReader</h1>
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wider">AI Reading Companion</p>
            </div>
          </div>

          <div className="flex-1 flex flex-col gap-4 overflow-hidden">
              <div className="grid grid-cols-3 gap-2 mb-2">
                <button 
                  onClick={() => setIsSearchModalOpen(true)}
                  className="flex flex-col items-center justify-center gap-1.5 py-3 px-2 bg-white border border-slate-100 text-indigo-600 rounded-2xl text-[10px] font-bold hover:bg-indigo-50 hover:border-indigo-100 transition-all shadow-sm"
                >
                  <Search size={16} />
                  Find Book
                </button>
                <button 
                  onClick={() => {
                    setIsLibraryOpen(true);
                    fetchLibrary();
                  }}
                  className="flex flex-col items-center justify-center gap-1.5 py-3 px-2 bg-white border border-slate-100 text-slate-600 rounded-2xl text-[10px] font-bold hover:bg-slate-50 hover:border-slate-200 transition-all shadow-sm"
                >
                  <Library size={16} />
                  Library
                </button>
                <button 
                  onClick={handleSave}
                  disabled={!mindMapData || isSaving}
                  className="flex flex-col items-center justify-center gap-1.5 py-3 px-2 bg-white border border-slate-100 text-emerald-600 rounded-2xl text-[10px] font-bold hover:bg-emerald-50 hover:border-emerald-100 disabled:opacity-50 transition-all shadow-sm"
                >
                  {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                  Save Map
                </button>
              </div>

            <div className="flex items-center bg-slate-100/50 p-1 rounded-xl mb-2 border border-slate-200/50 backdrop-blur-sm">
              <button 
                onClick={() => setViewMode('edit')}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-2 text-xs font-bold rounded-lg transition-all",
                  viewMode === 'edit' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                )}
              >
                <Edit3 size={14} />
                Edit
              </button>
              <button 
                onClick={() => setViewMode('read')}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-2 text-xs font-bold rounded-lg transition-all",
                  viewMode === 'read' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                )}
              >
                <Eye size={14} />
                Read
              </button>
            </div>

            <div className="flex-1 flex flex-col overflow-hidden group">
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                  {viewMode === 'edit' ? <Plus size={16} className="text-indigo-500" /> : <BookOpen size={16} className="text-indigo-500" />}
                  {viewMode === 'edit' ? 'Input Text or Article' : 'Reading View'}
                </label>
                {viewMode === 'edit' && inputText && (
                  <button 
                    onClick={() => setInputText('')}
                    className="text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-red-500 transition-colors flex items-center gap-1"
                  >
                    <X size={10} />
                    Clear
                  </button>
                )}
              </div>
              
              <div className="flex-1 relative">
                {viewMode === 'edit' ? (
                  <>
                    <textarea
                      value={inputText}
                      onChange={(e) => setInputText(e.target.value)}
                      placeholder="Paste your text here to generate a visual mind map..."
                      className={cn(
                        "w-full h-full p-5 rounded-2xl border-2 bg-white outline-none resize-none text-sm leading-relaxed transition-all shadow-inner",
                        inputText.length > 0 
                          ? "border-indigo-200 focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10" 
                          : "border-slate-100 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/5"
                      )}
                    />
                    {!inputText && (
                      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none opacity-20">
                        <FileText size={48} className="text-slate-400 mb-2" />
                        <p className="text-xs font-medium text-slate-400">Drop your content here</p>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="w-full h-full p-6 rounded-2xl border-2 border-slate-100 bg-white overflow-y-auto prose prose-slate prose-sm max-w-none shadow-inner custom-scrollbar">
                    {inputText ? (
                      <Markdown>{inputText}</Markdown>
                    ) : (
                      <div className="h-full flex flex-col items-center justify-center text-slate-300 italic">
                        <BookOpen size={32} className="mb-2 opacity-20" />
                        <p>No text to display.</p>
                      </div>
                    )}
                  </div>
                )}
              </div>
              
              {viewMode === 'edit' && (
                <div className="mt-2 flex items-center justify-between px-1">
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      "text-[10px] font-bold px-2 py-0.5 rounded-full",
                      inputText.length > 0 ? "bg-indigo-50 text-indigo-600" : "bg-slate-50 text-slate-400"
                    )}>
                      {inputText.length} characters
                    </span>
                    {inputText.length > 500 && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600 flex items-center gap-1">
                        <Sparkles size={10} />
                        Rich Content
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-slate-400 font-medium italic">
                    Supports Markdown
                  </div>
                </div>
              )}
            </div>

            <button
              onClick={handleGenerate}
              disabled={isLoading || !inputText.trim()}
              className={cn(
                "w-full py-4 px-4 rounded-2xl font-bold flex items-center justify-center gap-3 transition-all relative overflow-hidden group",
                isLoading || !inputText.trim() 
                  ? "bg-slate-100 text-slate-400 cursor-not-allowed" 
                  : "bg-indigo-600 text-white hover:bg-indigo-700 shadow-xl shadow-indigo-200 hover:-translate-y-0.5 active:translate-y-0"
              )}
            >
              {isLoading ? (
                <Loader2 className="animate-spin" size={20} />
              ) : (
                <div className="relative">
                  <Send size={20} className="group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform" />
                  {!isLoading && inputText.trim() && (
                    <motion.div 
                      layoutId="sparkle"
                      className="absolute -top-1 -right-1"
                      animate={{ scale: [1, 1.2, 1], opacity: [0.5, 1, 0.5] }}
                      transition={{ repeat: Infinity, duration: 2 }}
                    >
                      <Sparkles size={10} className="text-indigo-200" />
                    </motion.div>
                  )}
                </div>
              )}
              <span className="tracking-tight">
                {isLoading ? 'Analyzing Knowledge...' : 'Generate Visual Map'}
              </span>
              
              {!isLoading && inputText.trim() && (
                <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:animate-[shimmer_1.5s_infinite]" />
              )}
            </button>
          </div>

          <div className="mt-8 pt-6 border-t border-slate-100">
            <div className="flex items-center justify-between text-xs text-slate-400">
              <span>Powered by Gemini 3 Flash</span>
              <div className="flex gap-3">
                <button onClick={handleClear} className="hover:text-red-500 transition-colors">
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Toggle Button */}
        <button 
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="absolute -right-4 top-1/2 -translate-y-1/2 w-8 h-8 bg-white border border-slate-200 rounded-full flex items-center justify-center shadow-sm z-10 hover:bg-slate-50 transition-colors"
        >
          {isSidebarOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
        </button>
      </motion.aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* Header */}
        <header className="h-16 border-b border-slate-200 bg-white/80 backdrop-blur-md flex items-center justify-between px-8 z-10 shrink-0">
          <div className="flex items-center gap-4">
            {!isSidebarOpen && (
              <button 
                onClick={() => setIsSidebarOpen(true)}
                className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
              >
                <BookOpen size={20} className="text-indigo-600" />
              </button>
            )}
            <div className="flex items-center gap-2">
              <Network size={20} className="text-slate-400" />
              <span className="text-sm font-medium text-slate-600 truncate max-w-[200px] md:max-w-none">
                {mindMapData ? (mindMapData.nodes.find(n => n.type === 'root')?.label || 'Visual Map View') : 'Visual Map View'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button 
              onClick={handleMainShare}
              className="hidden md:flex items-center gap-2 py-2 px-3 text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all font-bold text-xs"
              title="Share Map"
            >
              <Share2 size={16} />
              Share
            </button>
            <button 
              onClick={exportMapAsImage}
              disabled={!mindMapData}
              className="flex items-center gap-2 py-2 px-4 bg-emerald-600 text-white hover:bg-emerald-700 rounded-xl transition-all shadow-lg shadow-emerald-100 font-bold text-xs disabled:opacity-30 disabled:shadow-none"
              title="Download Map as PNG"
            >
              <Download size={16} />
              Export PNG
            </button>
            <button 
              onClick={() => setIsInfoModalOpen(true)}
              className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all"
              title="App Info"
            >
              <Info size={20} />
            </button>
          </div>
        </header>

        {/* Canvas Area */}
        <div className="flex-1 relative p-4 md:p-8 overflow-hidden">
          {mindMapData ? (
            <div ref={mapContainerRef} className="w-full h-full relative">
              <MindMap 
                ref={mindMapRef}
                data={mindMapData} 
                onNodeClick={(node) => setSelectedNode(node)} 
              />
              
              {/* Node Info Overlay */}
              <AnimatePresence>
                {selectedNode && (
                  <motion.div
                    initial={{ opacity: 0, y: 20, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 20, scale: 0.95 }}
                    className="absolute bottom-6 right-6 w-80 bg-white rounded-2xl shadow-2xl border border-slate-200 p-6 z-20"
                  >
                    <button 
                      onClick={() => setSelectedNode(null)}
                      className="absolute top-4 right-4 text-slate-400 hover:text-slate-600"
                    >
                      <Plus size={20} className="rotate-45" />
                    </button>
                    <div className="flex items-center gap-2 mb-3">
                      <div 
                        className="w-3 h-3 rounded-full" 
                        style={{ backgroundColor: selectedNode.color }}
                      />
                      <span className="text-xs font-bold uppercase tracking-widest text-slate-400">
                        {selectedNode.type} Concept
                      </span>
                    </div>
                    <h3 className="text-lg font-bold mb-2">{selectedNode.label}</h3>
                    <p className="text-sm text-slate-600 leading-relaxed mb-4">
                      {selectedNode.description || 'No additional details available for this concept.'}
                    </p>
                    <button
                      onClick={handleExpand}
                      disabled={isExpanding}
                      className="w-full py-2 px-4 bg-indigo-600 text-white rounded-xl text-xs font-bold flex items-center justify-center gap-2 hover:bg-indigo-700 transition-all shadow-md shadow-indigo-100"
                    >
                      {isExpanding ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                      {isExpanding ? 'Preparing Guide...' : 'Deep Dive Study'}
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center text-slate-400">
              <div className="w-24 h-24 bg-slate-100 rounded-full flex items-center justify-center mb-6">
                <Network size={48} className="text-slate-300" />
              </div>
              <h2 className="text-xl font-semibold text-slate-600 mb-2">No Mind Map Generated</h2>
              <p className="text-sm max-w-xs text-center leading-relaxed">
                Paste some text in the sidebar and click generate to visualize the key concepts and their relationships.
              </p>
            </div>
          )}
        </div>
      </main>

        {/* Library Modal */}
        <AnimatePresence>
          {isLibraryOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsLibraryOpen(false)}
                className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
              />
              <motion.div 
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                className="relative w-full max-w-2xl bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
              >
                <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <h2 className="text-xl font-bold flex items-center gap-2">
                      <Library className="text-indigo-600" />
                      Your Library
                    </h2>
                    <button 
                      onClick={() => fetchLibrary(true)}
                      disabled={isRefreshingLibrary}
                      className={cn(
                        "p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-all",
                        isRefreshingLibrary && "animate-spin text-indigo-600"
                      )}
                      title="Refresh Library"
                    >
                      <Plus size={18} className={cn(isRefreshingLibrary ? "rotate-0" : "rotate-45")} />
                    </button>
                  </div>
                  <button onClick={() => setIsLibraryOpen(false)} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
                    <X size={20} />
                  </button>
                </div>
                
                <div className="p-6 flex flex-col gap-6 overflow-hidden">
                  <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                    {isLoadingLibrary ? (
                      <div className="h-64 flex items-center justify-center">
                        <Loader2 className="animate-spin text-indigo-600" size={32} />
                      </div>
                    ) : libraryItems.length > 0 ? (
                      <div className="grid grid-cols-1 gap-4">
                        {libraryItems.map((item) => (
                          <div 
                            key={item.id}
                            onClick={() => loadFromLibrary(item)}
                            className="flex gap-4 p-4 rounded-2xl border border-slate-100 hover:border-indigo-200 hover:bg-indigo-50/30 cursor-pointer transition-all group"
                          >
                            <div className="w-12 h-12 bg-indigo-50 rounded-xl flex items-center justify-center text-indigo-600 group-hover:bg-indigo-600 group-hover:text-white transition-all">
                              <Network size={24} />
                            </div>
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <h3 className="font-bold text-slate-900 group-hover:text-indigo-600 transition-colors">{item.title}</h3>
                                <span className={cn(
                                  "text-[10px] px-1.5 py-0.5 rounded-full font-bold uppercase tracking-wider",
                                  item.source === 'firebase' ? "bg-orange-100 text-orange-600" : 
                                  item.source === 'backend' ? "bg-emerald-100 text-emerald-600" :
                                  "bg-blue-100 text-blue-600"
                                )}>
                                  {item.source}
                                </span>
                              </div>
                              <p className="text-xs text-slate-400">{new Date(item.createdAt).toLocaleDateString()} at {new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                            </div>
                            <div className="flex items-center gap-2">
                              <button 
                                onClick={(e) => deleteFromLibrary(e, item)}
                                className="p-2 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                              >
                                <Trash2 size={18} />
                              </button>
                              <ChevronRight size={20} className="text-slate-300 group-hover:text-indigo-400" />
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="h-64 flex flex-col items-center justify-center text-slate-400">
                        <Library size={48} className="mb-4 opacity-20" />
                        <p>Your library is empty. Save a mind map to see it here.</p>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Expanded Content Modal */}
        <AnimatePresence>
          {expandedContent && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => {
                  setExpandedContent(null);
                  setActiveTopic('');
                }}
                className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
              />
              <motion.div 
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                className="relative w-full max-w-3xl bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
              >
                <div className="px-8 py-10 border-b border-slate-100 flex items-center justify-between bg-white">
                  <div className="flex items-center gap-5">
                    <div className="w-14 h-14 bg-indigo-600 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-indigo-200">
                      <Sparkles size={28} />
                    </div>
                    <div>
                      <h2 className="text-3xl font-black text-slate-900 tracking-tight leading-none mb-1">{activeTopic || selectedNode?.label}</h2>
                      <p className="text-sm text-slate-400 font-medium tracking-wide uppercase">Deep Dive Study Guide</p>
                    </div>
                  </div>
                  <button 
                    onClick={() => {
                      setExpandedContent(null);
                      setActiveTopic('');
                    }} 
                    className="p-3 hover:bg-slate-100 text-slate-400 hover:text-slate-900 rounded-2xl transition-all"
                  >
                    <X size={24} />
                  </button>
                </div>
                
                <div className="p-8 overflow-y-auto custom-scrollbar bg-slate-50">
                  {/* AI Illustration Section */}
                  <div className="mb-8 flex flex-col items-center">
                    {generatedTopicImage ? (
                      <div className="w-full relative group">
                        <img 
                          src={generatedTopicImage} 
                          alt={selectedNode?.label} 
                          className="w-full rounded-3xl shadow-xl border-4 border-white object-cover max-h-[400px]"
                          referrerPolicy="no-referrer"
                        />
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity rounded-3xl flex items-center justify-center">
                          <button 
                            onClick={generateAIIllustration}
                            className="px-6 py-3 bg-white text-slate-900 rounded-xl font-bold flex items-center gap-2 hover:bg-indigo-50 transition-all"
                          >
                            <Sparkles size={18} className="text-indigo-600" />
                            Regenerate Illustration
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button 
                        onClick={generateAIIllustration}
                        disabled={isGeneratingImage}
                        className="w-full py-12 bg-white border-2 border-dashed border-slate-200 rounded-3xl flex flex-col items-center justify-center gap-4 hover:border-indigo-300 hover:bg-indigo-50/30 transition-all group"
                      >
                        {isGeneratingImage ? (
                          <>
                            <Loader2 size={48} className="text-indigo-600 animate-spin" />
                            <div className="text-center">
                              <p className="font-bold text-slate-900">Generating AI Illustration...</p>
                              <p className="text-xs text-slate-500">Creating a unique visual for {selectedNode?.label}</p>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="w-16 h-16 bg-indigo-50 rounded-2xl flex items-center justify-center text-indigo-600 group-hover:scale-110 transition-transform">
                              <Sparkles size={32} />
                            </div>
                            <div className="text-center">
                              <p className="font-bold text-slate-900">Generate AI Illustration</p>
                              <p className="text-xs text-slate-500">Create a unique, high-quality visual for this topic</p>
                            </div>
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  <div ref={articleRef} className="article-content max-w-none bg-white p-10 md:p-16 rounded-3xl shadow-sm border border-slate-100">
                    <Markdown
                      components={{
                        img: ({ node, ...props }) => (
                          <img 
                            {...props} 
                            referrerPolicy="no-referrer" 
                            className="rounded-2xl shadow-md border border-slate-100 my-8 w-full object-cover max-h-[400px]"
                          />
                        )
                      }}
                    >
                      {expandedContent.text}
                    </Markdown>
                  </div>

                  {expandedContent.trendingQueries && expandedContent.trendingQueries.length > 0 && (
                    <div className="mt-12 bg-slate-50 p-8 rounded-3xl border border-slate-100">
                      <h3 className="text-xs font-black text-indigo-600 uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
                        <TrendingUp size={14} />
                        Trending & Related
                      </h3>
                      <div className="flex flex-wrap gap-3">
                        {expandedContent.trendingQueries.map((query, i) => (
                          <button 
                            key={i}
                            onClick={() => handleRelatedQuery(query)}
                            disabled={isExpanding}
                            className="px-5 py-2.5 rounded-xl bg-white text-slate-700 text-sm font-semibold border border-slate-200 shadow-sm hover:border-indigo-300 hover:text-indigo-600 transition-all flex items-center gap-2 group disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <Search size={12} className="text-indigo-400 group-hover:scale-110 transition-transform" />
                            {query}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {expandedContent.links && expandedContent.links.length > 0 && (
                    <div className="mt-8 bg-slate-50 p-8 rounded-3xl border border-slate-100">
                      <h3 className="text-xs font-black text-indigo-600 uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
                        <Library size={14} />
                        Verified Sources
                      </h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {expandedContent.links.map((link, i) => (
                          <a 
                            key={i} 
                            href={link.uri} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="flex items-center gap-4 p-4 rounded-2xl bg-white border border-slate-200 hover:border-indigo-400 hover:shadow-md transition-all group"
                          >
                            <div className="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center text-indigo-600 shadow-inner group-hover:bg-indigo-600 group-hover:text-white transition-all">
                              <Search size={16} />
                            </div>
                            <span className="text-sm font-bold text-slate-700 truncate">{link.title}</span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="mt-8 bg-slate-50 p-8 rounded-3xl border border-slate-100">
                    <h3 className="text-xs font-black text-indigo-600 uppercase tracking-[0.2em] mb-6 flex items-center gap-2">
                      <Download size={14} />
                      Export & Share
                    </h3>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                      <button 
                        onClick={exportAsText}
                        className="flex flex-col items-center gap-3 p-5 rounded-2xl bg-white border border-slate-200 hover:border-indigo-400 hover:shadow-md transition-all group"
                      >
                        <div className="w-12 h-12 bg-slate-50 rounded-xl flex items-center justify-center text-slate-400 group-hover:bg-indigo-600 group-hover:text-white transition-all">
                          <FileText size={24} />
                        </div>
                        <span className="text-xs font-black text-slate-600 uppercase tracking-wider">Text</span>
                      </button>
                      <button 
                        onClick={exportAsPDF}
                        className="flex flex-col items-center gap-3 p-5 rounded-2xl bg-white border border-slate-200 hover:border-indigo-400 hover:shadow-md transition-all group"
                      >
                        <div className="w-12 h-12 bg-slate-50 rounded-xl flex items-center justify-center text-slate-400 group-hover:bg-rose-600 group-hover:text-white transition-all">
                          <FileJson size={24} />
                        </div>
                        <span className="text-xs font-black text-slate-600 uppercase tracking-wider">PDF</span>
                      </button>
                      <button 
                        onClick={exportAsWord}
                        className="flex flex-col items-center gap-3 p-5 rounded-2xl bg-white border border-slate-200 hover:border-indigo-400 hover:shadow-md transition-all group"
                      >
                        <div className="w-12 h-12 bg-slate-50 rounded-xl flex items-center justify-center text-slate-400 group-hover:bg-blue-600 group-hover:text-white transition-all">
                          <FileText size={24} />
                        </div>
                        <span className="text-xs font-black text-slate-600 uppercase tracking-wider">Word</span>
                      </button>
                      <button 
                        onClick={exportAsImage}
                        className="flex flex-col items-center gap-3 p-5 rounded-2xl bg-white border border-slate-200 hover:border-indigo-400 hover:shadow-md transition-all group"
                      >
                        <div className="w-12 h-12 bg-slate-50 rounded-xl flex items-center justify-center text-slate-400 group-hover:bg-emerald-600 group-hover:text-white transition-all">
                          <ImageIcon size={24} />
                        </div>
                        <span className="text-xs font-black text-slate-600 uppercase tracking-wider">Image</span>
                      </button>
                      <button 
                        onClick={async () => {
                          if (navigator.share) {
                            try {
                              await navigator.share({
                                title: selectedNode?.label,
                                text: expandedContent.text,
                                url: window.location.href
                              });
                              showToast('Shared successfully!');
                            } catch (err) {
                              console.error('Share failed:', err);
                            }
                          } else {
                            try {
                              await navigator.clipboard.writeText(`${selectedNode?.label}\n\n${expandedContent.text}\n\nShared from AI Mind Map`);
                              showToast('Link copied to clipboard!');
                            } catch (err) {
                              showToast('Failed to copy. Try exporting as Text instead.', 'error');
                            }
                          }
                        }}
                        className="flex flex-col items-center gap-3 p-5 rounded-2xl bg-white border border-slate-200 hover:border-indigo-400 hover:shadow-md transition-all group"
                      >
                        <div className="w-12 h-12 bg-slate-50 rounded-xl flex items-center justify-center text-slate-400 group-hover:bg-indigo-600 group-hover:text-white transition-all">
                          <Share2 size={24} />
                        </div>
                        <span className="text-xs font-black text-slate-600 uppercase tracking-wider">Share</span>
                      </button>
                    </div>
                  </div>

                  <div className="mt-8 flex justify-center pb-4">
                    <button 
                      onClick={() => {
                        setExpandedContent(null);
                        setActiveTopic('');
                      }}
                      className="px-8 py-3 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 transition-all"
                    >
                      Done Studying
                    </button>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Search Modal */}
      <AnimatePresence>
        {isSearchModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsSearchModalOpen(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-2xl bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <Search className="text-indigo-600" />
                  Find Knowledge
                </h2>
                <button onClick={() => setIsSearchModalOpen(false)} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
                  <X size={20} />
                </button>
              </div>
              
              <div className="p-6 flex flex-col gap-6 overflow-hidden">
                <div className="relative">
                  <input 
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                    placeholder="Search for books, articles, or topics..."
                    className="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                  />
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={20} />
                  <button 
                    onClick={handleSearch}
                    disabled={isSearching || !searchQuery.trim()}
                    className="absolute right-2 top-1/2 -translate-y-1/2 px-4 py-2 bg-indigo-600 text-white rounded-xl text-sm font-bold hover:bg-indigo-700 disabled:opacity-50 transition-all"
                  >
                    {isSearching ? <Loader2 size={16} className="animate-spin" /> : 'Search'}
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                  {isSearching ? (
                    <div className="h-64 flex items-center justify-center">
                      <Loader2 className="animate-spin text-indigo-600" size={32} />
                    </div>
                  ) : searchResults.length > 0 ? (
                    <div className="grid grid-cols-1 gap-4">
                      {searchResults.map((book) => (
                        <div 
                          key={book.id}
                          onClick={() => selectBook(book)}
                          className="flex gap-4 p-4 rounded-2xl border border-slate-100 hover:border-indigo-200 hover:bg-indigo-50/30 cursor-pointer transition-all group"
                        >
                          {book.thumbnail ? (
                            <img src={book.thumbnail} alt={book.title} className="w-16 h-24 object-cover rounded-lg shadow-sm" referrerPolicy="no-referrer" />
                          ) : (
                            <div className="w-16 h-24 bg-slate-100 rounded-lg flex items-center justify-center text-slate-300">
                              <BookOpen size={24} />
                            </div>
                          )}
                          <div className="flex-1">
                            <h3 className="font-bold text-slate-900 group-hover:text-indigo-600 transition-colors">{book.title}</h3>
                            <p className="text-xs text-slate-500 mb-2">{book.authors.join(', ')}</p>
                            <p className="text-xs text-slate-400 line-clamp-2 leading-relaxed">{book.description}</p>
                          </div>
                          <ChevronRight size={20} className="text-slate-300 group-hover:text-indigo-400 self-center" />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="h-64 flex flex-col items-center justify-center text-slate-400">
                      <Search size={48} className="mb-4 opacity-20" />
                      <p>Search for a book or topic to get started.</p>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 20, x: '-50%' }}
            className={cn(
              "fixed bottom-8 left-1/2 z-[100] px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 border backdrop-blur-md",
              toast.type === 'success' 
                ? "bg-emerald-500/90 text-white border-emerald-400" 
                : "bg-rose-500/90 text-white border-rose-400"
            )}
          >
            {toast.type === 'success' ? <Save size={18} /> : <Info size={18} />}
            <span className="font-bold text-sm">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Info Modal */}
      <AnimatePresence>
        {isInfoModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsInfoModalOpen(false)}
              className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-lg bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-indigo-600 text-white">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <Info size={24} />
                  About MindReader
                </h2>
                <button onClick={() => setIsInfoModalOpen(false)} className="p-2 hover:bg-white/10 rounded-full transition-colors">
                  <X size={20} />
                </button>
              </div>
              
              <div className="p-8 space-y-6">
                <div>
                  <h3 className="text-lg font-bold text-slate-900 mb-2">AI-Powered Mind Mapping</h3>
                  <p className="text-sm text-slate-600 leading-relaxed">
                    MindReader uses advanced Gemini 3 Flash AI to analyze your text and visually map out key concepts, relationships, and hierarchies.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <Network className="text-indigo-600 mb-2" size={20} />
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Interactive</h4>
                    <p className="text-xs text-slate-600">Drag nodes, zoom, and click to expand sub-topics.</p>
                  </div>
                  <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                    <Sparkles className="text-emerald-600 mb-2" size={20} />
                    <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-1">Deep Dive</h4>
                    <p className="text-xs text-slate-600">Generate personalized study guides for any concept.</p>
                  </div>
                </div>

                <div className="pt-4 border-t border-slate-100">
                  <p className="text-[10px] text-slate-400 text-center uppercase tracking-[0.2em] font-bold">
                    Version 2.0 • Built with Google AI
                  </p>
                </div>

                <button 
                  onClick={() => setIsInfoModalOpen(false)}
                  className="w-full py-3 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 transition-all"
                >
                  Got it!
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
