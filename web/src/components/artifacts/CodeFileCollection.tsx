import { useState, useRef } from 'react'
import { FileTree, type FileTreeItem } from './FileTree'
import { CodeFile } from './CodeFile'

// File tree data structure
const fileTreeData: FileTreeItem[] = [
  {
    id: "folder-1",
    name: "folder-1",
    type: "folder",
    children: [
      { id: "folder-1-1", name: "folder-1-1", type: "folder" },
      { id: "folder-1-2", name: "folder-1-2", type: "folder" },
      { id: "folder-1-3", name: "folder-1-3", type: "folder" },
      { id: "folder-1-1item", name: "folder-1-1item", type: "file" },
      { id: "folder-1-2item", name: "folder-1-2item", type: "file" },
    ]
  },
  {
    id: "folder-2",
    name: "folder-2",
    type: "folder",
    children: [
      { id: "folder-2-1", name: "folder-2-1", type: "folder" },
      { id: "folder-2-2", name: "folder-2-2", type: "folder" },
      { id: "folder-2-3", name: "folder-2-3", type: "folder" },
      { id: "folder-2-1item", name: "folder-2-1item", type: "file" },
      { id: "folder-2-2item", name: "folder-2-2item", type: "file" },
    ]
  },
  {
    id: "folder-3",
    name: "folder-3",
    type: "folder",
    children: [
      { id: "folder-3-1", name: "folder-3-1", type: "folder" },
      { id: "folder-3-2", name: "folder-3-2", type: "folder" },
      { id: "folder-3-3", name: "folder-3-3", type: "folder" },
      { id: "folder-3-1item", name: "folder-3-1item", type: "file" },
      { id: "folder-3-2item", name: "folder-3-2item", type: "file" },
    ]
  },
  { id: "main.tf", name: "main.tf", type: "file" },
  { id: "vars.tf", name: "vars.tf", type: "file" },
];

// Simple OpenTofu example
const codeString = `# Simple OpenTofu configuration
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-west-2"
}

# Create a VPC
resource "aws_vpc" "main" {
  cidr_block = "10.0.0.0/16"
  tags = {
    Name = "main-vpc"
  }
}

# Create a security group
resource "aws_security_group" "web" {
  name_prefix = "web-"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

output "vpc_id" {
  value = aws_vpc.main.id
}`


interface CodeFileCollectionProps {
  className?: string;
}

export const CodeFileCollection = ({ className = "" }: CodeFileCollectionProps) => {
  const [treeWidth, setTreeWidth] = useState(200);
  const mainTfRef = useRef<HTMLDivElement>(null);
  const varsTfRef = useRef<HTMLDivElement>(null);

  // Handle file tree item clicks
  const handleFileTreeClick = (item: FileTreeItem) => {
    if (item.name === 'main.tf') {
      scrollToMainTf();
    } else if (item.name === 'vars.tf') {
      scrollToVarsTf();
    }
  };

  // Handle file tree width changes
  const handleTreeWidthChange = (width: number) => {
    setTreeWidth(width);
  };

  // Handle scrolling to file sections
  const scrollToMainTf = () => {
    if (mainTfRef.current) {
      const elementTop = mainTfRef.current.offsetTop;
      const scrollContainer = mainTfRef.current.closest('.overflow-y-auto');
      if (scrollContainer) {
        scrollContainer.scrollTo({
          top: elementTop - 52, // 52px above the file header to ensure it's visible
          behavior: 'smooth'
        });
      }
    }
  };

  const scrollToVarsTf = () => {
    if (varsTfRef.current) {
      const elementTop = varsTfRef.current.offsetTop;
      const scrollContainer = varsTfRef.current.closest('.overflow-y-auto');
      if (scrollContainer) {
        scrollContainer.scrollTo({
          top: elementTop - 52, // 52px above the file header to ensure it's visible
          behavior: 'smooth'
        });
      }
    }
  };

  return (
    <div className={`p-1 w-full min-h-[200px] ${className}`}>
      <FileTree 
        items={fileTreeData}
        onItemClick={handleFileTreeClick}
        onWidthChange={handleTreeWidthChange}
        className="absolute"
        minWidth={150}
        maxWidth={300}
      />

      <div style={{ marginLeft: `${treeWidth}px` }}>
        <div ref={mainTfRef}>
          <CodeFile
            fileName="main.tf"
            filePath="main.tf"
            code={codeString}
            language="hcl"
            showLineNumbers={true}
          />
        </div>

        <div ref={varsTfRef}>
          <CodeFile
            fileName="vars.tf"
            filePath="vars.tf"
            code={codeString}
            language="hcl"
            showLineNumbers={true}
          />
        </div>
      </div>
    </div>
    )
}
