import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { coy } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { CodeFileHeader } from './CodeFileHeader';


export interface CodeFileProps {
  // File identification
  fileName: string;
  filePath?: string; // Optional path for copy functionality
  
  // Code content
  code: string;
  
  // Syntax highlighting
  language?: string; // Default: 'text'
  showLineNumbers?: boolean; // Default: true
  
  // Header options
  showCopyCodeButton?: boolean;
  showCopyPathButton?: boolean;
  
  // Styling
  className?: string;
}

export const CodeFile = ({ 
  fileName, 
  filePath, 
  code, 
  language = 'text',
  showLineNumbers = true,
  showCopyCodeButton = true,
  showCopyPathButton = true,
  className = ""
}: CodeFileProps) => {
  // Use filePath if provided, otherwise fall back to fileName
  const displayPath = filePath || fileName;

  return (
    <div className={className}>
      {/* File Header */}
      <CodeFileHeader 
        filePath={displayPath}
        code={code}
        showCopyCodeButton={showCopyCodeButton}
        showCopyPathButton={showCopyPathButton}
      />

      {/* Syntax Highlighter */}
      <SyntaxHighlighter 
        language={language}
        style={coy}
        showLineNumbers={showLineNumbers}
        customStyle={{
          fontSize: '12px',
          border: '1px solid #ddd',
          borderRadius: '2px',
          padding: '14px 0px'
        }}
        lineNumberStyle={{
          color: '#999',
          fontSize: '11px',
          paddingRight: '12px',
          borderRight: '1px solid #eee',
          marginRight: '8px'
        }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
};
