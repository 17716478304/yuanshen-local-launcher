#import <AppKit/AppKit.h>
#import <objc/message.h>
#import <dlfcn.h>
int main(int argc, const char *argv[]) {
 @autoreleasepool {
  if(argc!=4) return 2;
  void *library=dlopen(argv[1],RTLD_LAZY|RTLD_LOCAL);
  if(!library){fprintf(stderr,"%s\n",dlerror());return 3;}
  Class iconClass=NSClassFromString(@"WineIconUtils");
  if(!iconClass) return 4;
  NSImage *source=[[NSImage alloc] initWithContentsOfFile:[NSString stringWithUTF8String:argv[2]]];
  CGImageRef image=[source CGImageForProposedRect:NULL context:nil hints:nil];
  NSImage *formatted=((id(*)(id,SEL,id))objc_msgSend)(iconClass,NSSelectorFromString(@"maskedAppIconFromCGImages:"),@[(__bridge id)image]);
  if(!formatted) return 5;
  NSBitmapImageRep *bitmap=[[NSBitmapImageRep alloc] initWithCGImage:[formatted CGImageForProposedRect:NULL context:nil hints:nil]];
  NSData *png=[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
  if(![png writeToFile:[NSString stringWithUTF8String:argv[3]] atomically:YES])return 6;
  fprintf(stdout,"Wine native icon mask produced %ld x %ld\n",(long)bitmap.pixelsWide,(long)bitmap.pixelsHigh);
 }
 return 0;
}
