param(
  [string]$OutDir = "corpus/gutenberg"
)

$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$books = @(
  @{ Name = "pride-and-prejudice.txt"; Url = "https://www.gutenberg.org/cache/epub/1342/pg1342.txt" },
  @{ Name = "frankenstein.txt"; Url = "https://www.gutenberg.org/cache/epub/84/pg84.txt" },
  @{ Name = "sherlock-holmes.txt"; Url = "https://www.gutenberg.org/cache/epub/1661/pg1661.txt" },
  @{ Name = "alice-in-wonderland.txt"; Url = "https://www.gutenberg.org/cache/epub/11/pg11.txt" },
  @{ Name = "dracula.txt"; Url = "https://www.gutenberg.org/cache/epub/345/pg345.txt" },
  @{ Name = "moby-dick.txt"; Url = "https://www.gutenberg.org/cache/epub/2701/pg2701.txt" },
  @{ Name = "the-time-machine.txt"; Url = "https://www.gutenberg.org/cache/epub/35/pg35.txt" },
  @{ Name = "a-tale-of-two-cities.txt"; Url = "https://www.gutenberg.org/cache/epub/98/pg98.txt" },
  @{ Name = "jane-eyre.txt"; Url = "https://www.gutenberg.org/cache/epub/1260/pg1260.txt" },
  @{ Name = "the-wonderful-wizard-of-oz.txt"; Url = "https://www.gutenberg.org/cache/epub/55/pg55.txt" },
  @{ Name = "the-picture-of-dorian-gray.txt"; Url = "https://www.gutenberg.org/cache/epub/174/pg174.txt" },
  @{ Name = "heart-of-darkness.txt"; Url = "https://www.gutenberg.org/cache/epub/219/pg219.txt" },
  @{ Name = "the-war-of-the-worlds.txt"; Url = "https://www.gutenberg.org/cache/epub/36/pg36.txt" },
  @{ Name = "treasure-island.txt"; Url = "https://www.gutenberg.org/cache/epub/120/pg120.txt" },
  @{ Name = "little-women.txt"; Url = "https://www.gutenberg.org/cache/epub/514/pg514.txt" }
)

foreach ($book in $books) {
  $target = Join-Path $OutDir $book.Name
  Write-Host "Downloading $($book.Url) -> $target"
  & curl.exe --fail --location --retry 3 --retry-delay 2 --output $target $book.Url
}

Write-Host "Project Gutenberg starter corpus written to $OutDir"
