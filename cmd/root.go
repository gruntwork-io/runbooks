package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"runbooks/api/telemetry"

	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

const (
	// maxLineWidth is the maximum width for help output (matches OpenTofu style)
	maxLineWidth = 76
	// commandIndent is the leading indentation for commands/flags
	commandIndent = "  "
)

var (
	// These variables are set via ldflags during build
	Version   = "dev"
	GitCommit = "none"
	BuildDate = "unknown"

	// Global flag for output path used by server commands
	outputPath string

	// Global flags for working directory
	workingDir    string
	workingDirTmp bool

	// Global flag to disable telemetry
	noTelemetry bool
)

// getVersionString returns the full version information
func getVersionString() string {
	return fmt.Sprintf("%s (Commit: %s)", Version, GitCommit)
}

// resolveWorkingDir determines the final working directory based on CLI flags.
// Returns the directory path, a cleanup function (nil if no cleanup needed), and an error.
func resolveWorkingDir(configuredWorkDir string, useTempDir bool) (string, func(), error) {
	if useTempDir {
		dir, err := os.MkdirTemp("", "runbook-workdir-*")
		if err != nil {
			return "", nil, fmt.Errorf("failed to create temp working directory: %w", err)
		}
		return dir, func() { os.RemoveAll(dir) }, nil
	}
	if configuredWorkDir != "" {
		absPath, err := filepath.Abs(configuredWorkDir)
		if err != nil {
			return "", nil, fmt.Errorf("failed to resolve working directory: %w", err)
		}
		return absPath, nil, nil
	}
	// Default: current directory (where CLI was launched)
	cwd, err := os.Getwd()
	if err != nil {
		return "", nil, fmt.Errorf("failed to get current working directory: %w", err)
	}
	return cwd, nil, nil
}

// rootCmd represents the base command when called without any subcommands
var rootCmd = &cobra.Command{
	Use:     "runbooks",
	Short:   "Make the knowledge and experience of the few available to the many.",
	Long:    `Runbooks makes it easy for subject matter experts to capture their knowledge, and easy for others to consume it.`,
	Version: getVersionString(),
	// PersistentPreRun is a Cobra lifecycle hook that runs BEFORE the Run function
	// of any subcommand (open, watch, serve, etc.). It's inherited by all subcommands,
	// making it ideal for global initialization like telemetry.
	PersistentPreRun: func(cmd *cobra.Command, args []string) {
		// Initialize telemetry with version and flag status
		telemetry.Init(Version, noTelemetry)

		// Print telemetry notice (only if enabled)
		// Skip for version and help commands to keep output clean
		if cmd.Name() != "version" && cmd.Name() != "help" && cmd.Name() != "runbooks" {
			telemetry.PrintNotice()
		}
	},
}

// Execute adds all child commands to the root command and sets flags appropriately.
// This is called by main.main(). It only needs to happen once to the rootCmd.
func Execute() {
	err := rootCmd.Execute()
	if err != nil {
		os.Exit(1)
	}
}

// mainCommandOrder defines the order of main commands in help output
var mainCommandOrder = []string{"open", "watch"}

// wrapText wraps text to fit within maxWidth, with subsequent lines indented
// to startColumn. Returns a single string with newlines.
func wrapText(text string, startColumn, maxWidth int) string {
	if startColumn+len(text) <= maxWidth {
		return text
	}

	var result strings.Builder
	availableWidth := maxWidth - startColumn
	indent := strings.Repeat(" ", startColumn)

	words := strings.Fields(text)
	currentLine := ""

	for _, word := range words {
		if currentLine == "" {
			currentLine = word
		} else if len(currentLine)+1+len(word) <= availableWidth {
			currentLine += " " + word
		} else {
			if result.Len() > 0 {
				result.WriteString("\n" + indent)
			}
			result.WriteString(currentLine)
			currentLine = word
		}
	}

	if currentLine != "" {
		if result.Len() > 0 {
			result.WriteString("\n" + indent)
		}
		result.WriteString(currentLine)
	}

	return result.String()
}

// formatHelpLine formats a single help line with name and description,
// wrapping the description if needed.
// nameWidth is the width allocated for the name column (should be longest name + 2)
func formatHelpLine(name, description string, nameWidth int) string {
	descStartCol := len(commandIndent) + nameWidth
	namePart := fmt.Sprintf("%s%-*s", commandIndent, nameWidth, name)
	return namePart + wrapText(description, descStartCol, maxLineWidth)
}

// formatFlags formats all flags for a command with proper wrapping
func formatFlags(cmd *cobra.Command, inherited bool) string {
	var result strings.Builder

	var flags []struct {
		name string
		desc string
	}

	flagSet := cmd.LocalFlags()
	if inherited {
		flagSet = cmd.InheritedFlags()
	}

	flagSet.VisitAll(func(f *pflag.Flag) {
		if f.Hidden {
			return
		}

		// Skip showing shorthand for help and version flags (they still work, just not displayed)
		var flagStr string
		if f.Shorthand != "" && f.Name != "help" && f.Name != "version" {
			flagStr = fmt.Sprintf("-%s, --%s", f.Shorthand, f.Name)
		} else {
			flagStr = fmt.Sprintf("--%s", f.Name)
		}

		// Add type if not bool (use = format like OpenTofu)
		if f.Value.Type() != "bool" {
			// Use descriptive type names instead of Go types
			typeName := f.Value.Type()
			if strings.HasSuffix(f.Name, "-path") || f.Name == "path" {
				typeName = "path"
			}
			flagStr += "=" + typeName
		}

		flags = append(flags, struct {
			name string
			desc string
		}{flagStr, f.Usage})
	})

	// Find the longest flag name to calculate dynamic width
	maxLen := 0
	for _, f := range flags {
		if len(f.name) > maxLen {
			maxLen = len(f.name)
		}
	}
	// Add 2 spaces after the longest flag
	nameWidth := maxLen + 2

	for _, f := range flags {
		result.WriteString(formatHelpLine(f.name, f.desc, nameWidth))
		result.WriteString("\n")
	}

	return result.String()
}

// customHelp generates a custom help output with proper text wrapping
// Applies to all commands with consistent formatting
func customHelp(cmd *cobra.Command, args []string) {
	// Print usage
	fmt.Print("Usage: ")
	if cmd.Name() == "runbooks" {
		fmt.Printf("%s [command]\n", cmd.Use)
	} else {
		fmt.Printf("%s\n", cmd.UseLine())
	}
	fmt.Println()

	// For subcommands, print the long description
	if cmd.Name() != "runbooks" && cmd.Long != "" {
		fmt.Println(cmd.Long)
		fmt.Println()
	}

	// For root command, print commands in sections
	if cmd.Name() == "runbooks" {
		// Calculate the maximum command name width dynamically
		maxNameLen := 0
		for _, subcmd := range cmd.Commands() {
			if !subcmd.Hidden && len(subcmd.Name()) > maxNameLen {
				maxNameLen = len(subcmd.Name())
			}
		}
		// Add 2 spaces after the longest command name for padding
		commandNameWidth := maxNameLen + 2

		// Print main commands in specified order
		fmt.Println("Main Commands:")
		for _, name := range mainCommandOrder {
			for _, subcmd := range cmd.Commands() {
				if subcmd.Name() == name && subcmd.GroupID == "main" {
					fmt.Println(formatHelpLine(subcmd.Name(), subcmd.Short, commandNameWidth))
				}
			}
		}
		fmt.Println()

		// Print other commands
		fmt.Println("All Other Commands:")
		for _, subcmd := range cmd.Commands() {
			if subcmd.GroupID == "other" && !subcmd.Hidden {
				fmt.Println(formatHelpLine(subcmd.Name(), subcmd.Short, commandNameWidth))
			}
		}
		fmt.Println()
	}

	// Print local flags
	if cmd.HasAvailableLocalFlags() {
		fmt.Println("Flags:")
		fmt.Print(formatFlags(cmd, false))
		fmt.Println()
	}

	// Print inherited/global flags for subcommands
	if cmd.Name() != "runbooks" && cmd.HasAvailableInheritedFlags() {
		fmt.Println("Global Flags:")
		fmt.Print(formatFlags(cmd, true))
		fmt.Println()
	}

	if cmd.Name() == "runbooks" {
		fmt.Printf("Use \"%s [command] --help\" for more information about a command.\n", cmd.Use)
		fmt.Println()
		fmt.Println("To learn more about Runbooks, go to https://runbooks.gruntwork.io.")
		fmt.Println()
	}
}

func init() {
	// Here you will define your flags and configuration settings.
	// Cobra supports:
	// - persistent flags: if defined here, will be global for your application.
	// - local flags: will only run when this action is called directly.

	// Add command groups for organized help output
	rootCmd.AddGroup(&cobra.Group{ID: "main", Title: "Main Commands:"})
	rootCmd.AddGroup(&cobra.Group{ID: "other", Title: "All Other Commands:"})

	// Set custom help function to control command order
	rootCmd.SetHelpFunc(customHelp)

	// Add persistent flags that are available to all subcommands
	rootCmd.PersistentFlags().StringVar(&outputPath, "output-path", "generated",
		"Path where generated files will be rendered (relative to working directory)")

	rootCmd.PersistentFlags().StringVar(&workingDir, "working-dir", "",
		"Working directory for script execution (default: current directory)")

	rootCmd.PersistentFlags().BoolVar(&workingDirTmp, "working-dir-tmp", false,
		"Use a temporary working directory (cleaned up on exit)")

	// Add telemetry opt-out flag
	rootCmd.PersistentFlags().BoolVar(&noTelemetry, "no-telemetry", false,
		"Disable anonymous telemetry (can also set RUNBOOKS_TELEMETRY_DISABLE=1)")

	// Hide the completion command from help
	rootCmd.CompletionOptions.HiddenDefaultCmd = true

	// Hide the help subcommand from help
	rootCmd.SetHelpCommand(&cobra.Command{Hidden: true})
}
