package catalog

import (
	"fmt"
	"image"
	"image/color"
	"math"
	"strings"
	"testing"
)

// flat is an image of one colour, which is what averaging should give
// straight back — before the fill band has its say.
func flat(c color.RGBA) image.Image {
	img := image.NewRGBA(image.Rect(0, 0, 40, 60))
	for y := 0; y < 60; y++ {
		for x := 0; x < 40; x++ {
			img.Set(x, y, c)
		}
	}
	return img
}

func TestPosterColourIsStableAndInsideTheBand(t *testing.T) {
	for _, c := range []struct {
		name string
		in   color.RGBA
	}{
		{"a bright red", color.RGBA{0xff, 0x00, 0x00, 0xff}},
		{"near black", color.RGBA{0x05, 0x05, 0x08, 0xff}},
		{"near white", color.RGBA{0xfa, 0xfa, 0xf5, 0xff}},
		{"a mid blue", color.RGBA{0x30, 0x50, 0xa0, 0xff}},
		{"a saturated green", color.RGBA{0x00, 0xff, 0x00, 0xff}},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := averageColour(flat(c.in))
			if !strings.HasPrefix(got, "#") || len(got) != 7 {
				t.Fatalf("colour = %q, want #rrggbb", got)
			}
			// The same picture always gives the same answer: the frame
			// a film shows must not change between visits.
			if again := averageColour(flat(c.in)); again != got {
				t.Errorf("%q then %q; the colour is not stable", got, again)
			}

			// Every fill has to carry white text and sit in either
			// theme, which is what the band is for.
			r, g, b := unhex(t, got)
			l, a, bb := srgbToOKLab(r, g, b)
			if l < fillMinL-0.01 || l > fillMaxL+0.01 {
				t.Errorf("lightness %.3f is outside %.2f–%.2f", l, fillMinL, fillMaxL)
			}
			if chroma := math.Hypot(a, bb); chroma > fillMaxC+0.01 {
				t.Errorf("chroma %.3f is past %.2f", chroma, fillMaxC)
			}
		})
	}
}

func TestPosterColourKeepsTheHue(t *testing.T) {
	// Clamping is about lightness and chroma. Which film this is comes
	// from the hue, so that is the part left alone.
	red := hueOf(t, averageColour(flat(color.RGBA{0xc0, 0x20, 0x20, 0xff})))
	blue := hueOf(t, averageColour(flat(color.RGBA{0x20, 0x20, 0xc0, 0xff})))
	apart := math.Abs(red - blue)
	if apart > math.Pi {
		apart = 2*math.Pi - apart
	}
	if apart < 1 {
		t.Errorf("a red and a blue came out %.2f radians apart; hue was lost", apart)
	}
}

func TestPosterColourNeedsAnAddress(t *testing.T) {
	if _, err := PosterColour(t.Context(), nil, ""); err == nil {
		t.Error("a film with no poster produced a colour")
	}
}

func hueOf(t *testing.T, hex string) float64 {
	t.Helper()
	r, g, b := unhex(t, hex)
	_, a, bb := srgbToOKLab(r, g, b)
	return math.Atan2(bb, a)
}

func unhex(t *testing.T, hex string) (float64, float64, float64) {
	t.Helper()
	var r, g, b int
	if _, err := fmt.Sscanf(hex, "#%02x%02x%02x", &r, &g, &b); err != nil {
		t.Fatalf("parse %q: %v", hex, err)
	}
	return float64(r) / 255, float64(g) / 255, float64(b) / 255
}
