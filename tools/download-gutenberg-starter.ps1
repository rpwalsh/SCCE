param(
  [string]$OutDir = "corpus/gutenberg"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$books = @(
  @{ Name = "pride-and-prejudice.txt"; Url = "https://www.gutenberg.org/cache/epub/1342/pg1342.txt" },
  @{ Name = "frankenstein.txt"; Url = "https://www.gutenberg.org/cache/epub/84/pg84.txt" },
  @{ Name = "sherlock-holmes.txt"; Url = "https://www.gutenberg.org/cache/epub/1661/pg1661.txt" }
)

foreach ($book in $books) {
  $target = Join-Path $OutDir $book.Name
  Write-Host "Downloading $($book.Url) -> $target"
  & curl.exe --fail --location --retry 3 --retry-delay 2 --output $target $book.Url
}

Write-Host "Project Gutenberg starter corpus written to $OutDir"
