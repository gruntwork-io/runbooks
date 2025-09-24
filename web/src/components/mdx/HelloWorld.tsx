export interface HelloWorldProps {
  message?: string;
}

export const HelloWorld = ({ message = "Hello, World!" }: HelloWorldProps) => {
  return (
    <div className="p-4 bg-blue-100 border border-blue-300 rounded-lg">
      <h3 className="text-lg font-semibold text-blue-800 mb-2">Hello World Component</h3>
      <p className="text-blue-700">{message}</p>
    </div>
  );
};
