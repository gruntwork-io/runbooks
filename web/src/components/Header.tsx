interface HeaderProps {
  pathName: string;
}

/**
 * A fixed header component that displays the branding and current file path.
 * 
 * The header uses a responsive design where mobile devices show only the file path
 * centered, while desktop devices show the full layout with branding and navigation.
 * 
 * @param props - The component props
 * @param props.pathName - The file path string to display in the center of the header
 */
export function Header({ pathName }: HeaderProps) {
  return (
    <header className="w-full border-b border-gray-300 p-4 text-gray-500 font-semibold flex fixed top-0 left-0 right-0 z-10 bg-bg-default">
      <div className="hidden md:block md:absolute md:left-5 md:top-1/2 md:transform md:-translate-y-1/2">
        Gruntwork Runbooks
      </div>
      <div className="flex-1 flex items-center gap-2 justify-center">
        <div className="text-xs md:text-sm text-gray-500 font-mono font-normal">
          {pathName}
        </div>
      </div>
      <div className="hidden md:block md:absolute md:right-5 md:top-1/2 md:transform md:-translate-y-1/2 font-normal text-md hover:underline decoration-current">
        <a href="https://gruntwork.io" target="_blank">About</a>
      </div>
    </header>
  );
}
