package catalog

// The colour a poster averages to, for the opening screen.
//
// The cold start draws eight frames before it has eight pictures, and a
// frame filled with the film's own colour is the difference between a
// page that is loading and a page that is empty. The picture then fades
// in over the fill it was already the colour of.
//
// It is one number per film and it never changes, so it is worked out
// once and kept beside the poster address.

import (
	"context"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"math"
	"net/http"

	xdraw "golang.org/x/image/draw"
)

// The band a fill is allowed to occupy, in OKLCH.
//
// A poster average can be anything from near-black to a saturated
// scream, and neither works: the frame carries white text over it and
// has to sit in a page that is itself either dark or light. Clamping
// lightness and chroma keeps every fill in the one range that reads in
// both themes, while leaving the hue — which is the part that says
// which film this is — untouched.
const (
	fillMinL = 0.28
	fillMaxL = 0.52
	fillMaxC = 0.12
)

// PosterColour is the average colour of a poster, as "#rrggbb".
//
// The whole image is reduced to a single pixel and that pixel is the
// answer. Scaling is the averaging: asking for one pixel out of a
// thousand is asking what they come to together.
func PosterColour(ctx context.Context, client *http.Client, url string) (string, error) {
	if url == "" {
		return "", fmt.Errorf("catalog: poster colour: no address")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", fmt.Errorf("catalog: poster colour: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("catalog: poster colour: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("catalog: poster colour: HTTP %d", resp.StatusCode)
	}
	img, _, err := image.Decode(resp.Body)
	if err != nil {
		return "", fmt.Errorf("catalog: poster colour: decode: %w", err)
	}
	return averageColour(img), nil
}

// averageColour is the poster in one pixel, put inside the band a fill
// has to stay in.
func averageColour(img image.Image) string {
	one := image.NewRGBA(image.Rect(0, 0, 1, 1))
	xdraw.ApproxBiLinear.Scale(one, one.Bounds(), img, img.Bounds(), xdraw.Src, nil)
	r, g, b, _ := one.At(0, 0).RGBA()
	return hexOf(fitFill(float64(r>>8)/255, float64(g>>8)/255, float64(b>>8)/255))
}

// fitFill puts an sRGB colour inside the fill band, keeping its hue.
func fitFill(r, g, b float64) (float64, float64, float64) {
	l, a, bb := srgbToOKLab(r, g, b)
	// Lightness and chroma are what make a fill unusable; hue is what
	// makes it this film's. So only the first two are moved.
	chroma := math.Hypot(a, bb)
	hue := math.Atan2(bb, a)
	l = math.Min(math.Max(l, fillMinL), fillMaxL)
	if chroma > fillMaxC {
		chroma = fillMaxC
	}
	return okLabToSRGB(l, chroma*math.Cos(hue), chroma*math.Sin(hue))
}

// srgbToOKLab converts one colour. OKLab rather than HSL because its
// lightness matches what an eye reports: clamping HSL's L leaves a
// yellow far brighter than a blue at the same number.
func srgbToOKLab(r, g, b float64) (float64, float64, float64) {
	lr, lg, lb := toLinear(r), toLinear(g), toLinear(b)
	l := math.Cbrt(0.4122214708*lr + 0.5363325363*lg + 0.0514459929*lb)
	m := math.Cbrt(0.2119034982*lr + 0.6806995451*lg + 0.1073969566*lb)
	s := math.Cbrt(0.0883024619*lr + 0.2817188376*lg + 0.6299787005*lb)
	return 0.2104542553*l + 0.7936177850*m - 0.0040720468*s,
		1.9779984951*l - 2.4285922050*m + 0.4505937099*s,
		0.0259040371*l + 0.7827717662*m - 0.8086757660*s
}

func okLabToSRGB(L, a, b float64) (float64, float64, float64) {
	l := cube(L + 0.3963377774*a + 0.2158037573*b)
	m := cube(L - 0.1055613458*a - 0.0638541728*b)
	s := cube(L - 0.0894841775*a - 1.2914855480*b)
	return toGamma(4.0767416621*l - 3.3077115913*m + 0.2309699292*s),
		toGamma(-1.2684380046*l + 2.6097574011*m - 0.3413193965*s),
		toGamma(-0.0041960863*l - 0.7034186147*m + 1.7076147010*s)
}

func cube(x float64) float64 { return x * x * x }

func toLinear(c float64) float64 {
	if c <= 0.04045 {
		return c / 12.92
	}
	return math.Pow((c+0.055)/1.055, 2.4)
}

func toGamma(c float64) float64 {
	if c <= 0.0031308 {
		c *= 12.92
	} else {
		c = 1.055*math.Pow(c, 1/2.4) - 0.055
	}
	// A clamped OKLCH colour can still land just outside sRGB; the
	// nearest colour that exists is the honest answer.
	return math.Min(math.Max(c, 0), 1)
}

func hexOf(r, g, b float64) string {
	return fmt.Sprintf("#%02x%02x%02x", round8(r), round8(g), round8(b))
}

func round8(c float64) uint8 { return uint8(math.Round(c * 255)) }
